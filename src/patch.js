/**
 * Produce a byte-exact patch describing the local working tree.
 *
 * Why a patch instead of a branch:
 *
 * Publishing a snapshot as a branch in the TARGET repository mutates a repo the
 * caller never asked to touch — it appears in their branch list, shows up in
 * forks, and survives indefinitely. That is the wrong default.
 *
 * A patch needs no branch anywhere. The cloud applies it to a checkout of the
 * user's own branch, builds, and the target repository is left exactly as it
 * was. The bytes that travel are the same either way (only what changed), so
 * there is no cost trade-off — this is strictly better than the branch approach
 * for the "don't touch my repo" requirement.
 *
 * Included:
 *   - committed-but-unpushed changes (compared against the REMOTE base commit)
 *   - uncommitted edits
 *   - new untracked files
 *   - deletions
 *
 * Excluded:
 *   - anything .gitignore hides (build outputs, secrets) — same rule as before
 *   - binary content is carried inline via `--binary`, so assets still work
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { isGitRepo, repoInfo, hasCommit, fetchCommit } from './workspace.js'

export class PatchError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PatchError'
  }
}

function git(dir, args, { env = {}, buffer = false, input } = {}) {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: buffer ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    ...(input ? { input } : {}),
    env: { ...process.env, ...env },
  })
}

/**
 * Build a patch from `baseSha` to the current working tree.
 *
 * @param {string} dir    local git work tree
 * @param {string} baseSha commit the patch applies on top of (remote base)
 * @returns {{patch:Buffer, files:Array<{path:string,kind:string}>, bytes:number}}
 */
export function createWorkspacePatch(dir, baseSha) {
  if (!isGitRepo(dir)) throw new PatchError(`不是 git 仓库：${dir}`)
  if (!hasCommit(dir, baseSha) && !fetchCommit(dir, baseSha)) {
    throw new PatchError(
      `本地没有远端基准提交 ${baseSha.slice(0, 7)}，也无法自动 fetch。\n` +
        '请确认本地仓库有可用的 origin remote，或把 ref 指向本地已有的分支。'
    )
  }

  // A throwaway index keeps the caller's real index untouched — an agent must be
  // able to build without its staging area being rearranged.
  const indexDir = mkdtempSync(join(tmpdir(), 'br-patch-idx-'))
  const indexFile = join(indexDir, 'index')
  const env = {
    GIT_INDEX_FILE: indexFile,
    GIT_CONFIG_NOSYSTEM: '1',
  }

  try {
    // DO NOT override core.autocrlf here.
    //
    // An earlier revision forced `core.autocrlf=false` to keep line endings
    // byte-exact. That was a serious bug: a Windows checkout stores LF in the
    // object database but writes CRLF to the working tree. Disabling autocrlf
    // makes `git add` compare raw bytes, so EVERY file looks modified — a
    // 1949-file repository produced a 46 MB patch containing the entire tree
    // instead of the handful of files the caller touched. That oversized upload
    // then failed at the API with a proxy-shaped 502.
    //
    // Line endings are handled where they belong: the runner is Linux, where
    // LF is native, and git's own conversion on checkout keeps the two sides
    // consistent. Diffing therefore happens with the repository's configured
    // settings, exactly as a normal `git diff` would.
    //
    // Seed the temp index from HEAD, NOT from baseSha.
    //
    // `read-tree baseSha` followed by `add -A` produces "base -> working tree".
    // That looks right until the working tree is clean: then it yields an EMPTY
    // patch even though local HEAD contains commits the base does not have. The
    // reported bug was exactly this — a committed-but-unpushed branch produced a
    // patch with no commits in it.
    //
    // Seeding from HEAD makes the index describe the local tree as committed
    // (plus any unstaged edits), and the diff against baseSha then includes
    // unpushed commits AND working changes.
    git(dir, ['read-tree', 'HEAD'], { env })
    git(dir, ['add', '-A'], { env })
    const patch = git(dir, ['diff', '--binary', '--cached', baseSha], {
      env,
      buffer: true,
    })

    // Report what the patch contains so the caller can confirm intent.
    const nameStatus = git(dir, ['diff', '--cached', '--name-status', baseSha], { env })
    const files = nameStatus
      .split('\n')
      .map(line => line.trim())
      .filter(line => line !== '')
      .map(line => {
        const [status, ...rest] = line.split('\t')
        const path = rest.join('\t')
        const kind =
          status.startsWith('A') ? 'added'
          : status.startsWith('D') ? 'deleted'
          : status.startsWith('R') ? 'renamed'
          : 'modified'
        return { path, kind }
      })

    return { patch, files, bytes: patch.length }
  } finally {
    rmSync(indexDir, { recursive: true, force: true })
  }
}

/**
 * Publish a patch to a transient branch in the ENGINE repo.
 *
 * Two transports, because one of them can be blocked by a local proxy while the
 * other works:
 *
 *   1. Git Data API — POST blob + tree + commit, then move the ref. Cheapest,
 *      and the normal path.
 *   2. Contents API — PUT the file directly on the branch. Different endpoint
 *      and body shape, so a proxy that rejects `POST /git/blobs` specifically
 *      (observed in the field: GET fine, POST blob 502 every time, while the
 *      same request succeeds from a standalone script) will usually let this
 *      through.
 *
 * Falling back costs one extra commit; failing costs the caller their build.
 *
 * Why a branch rather than a dispatch input: `workflow_dispatch` inputs are
 * capped at ~61 KiB (measured), and a real workspace patch is routinely larger.
 * Why the ENGINE repo rather than the target: the point is to leave the
 * caller's repository untouched.
 */
export async function publishPatchToEngine(client, { owner, repo, branch, patch }) {
  const path = '.build-runner/workspace.patch'
  const message = `build-runner: workspace patch (${patch.length} bytes)`

  const attempts = []

  // Transport 1: Git Data API.
  try {
    const result = await client.publishBlobFile(owner, repo, {
      branch,
      path,
      content: patch,
      message,
    })
    return { ...result, transport: 'git-data' }
  } catch (error) {
    attempts.push(`git-data: ${error.message.split('\n')[0].slice(0, 120)}`)
  }

  // Transport 2: Contents API. Base64 is stored as the file body, so the runner
  // decodes it before applying — see the workflow's Fetch workspace patch step.
  try {
    const base = await client.resolveCommit(owner, repo, 'main')
    // `putFile` needs the branch to exist; create or reset it first.
    await client.upsertRef(owner, repo, branch, base.sha, { force: true })
    const encoded = patch.toString('base64')
    const res = await client.putFile(owner, repo, path, {
      text: encoded,
      message,
      branch,
    })
    return {
      branch,
      sha: res.commit?.sha ?? null,
      transport: 'contents',
      encoded: true,
    }
  } catch (error) {
    attempts.push(`contents: ${error.message.split('\n')[0].slice(0, 120)}`)
  }

  throw new PatchError(
    `两种传输方式都失败了：\n  ${attempts.join('\n  ')}\n` +
      '如果两者都是代理返回的 502，说明本机网关在拦截写请求；可尝试直连或换网络。'
  )
}

/** Remove the transient branch; best-effort, never fatal. */
export async function deleteEngineBranch(client, { owner, repo, branch }) {
  try {
    await client.deleteRef(owner, repo, `heads/${branch}`)
    return true
  } catch {
    return false
  }
}

/** Apply a patch to a checkout. Runs on the runner. */
export function applyPatchScript() {
  return [
    'if [ ! -s /tmp/br.patch ]; then',
    '  echo "[build-runner] 没有改动需要应用"',
    'else',
    '  git apply --binary --whitespace=nowarn /tmp/br.patch \\',
    '    || git apply --binary --whitespace=nowarn -3 /tmp/br.patch \\',
    '    || { echo "::error::补丁应用失败，云端代码与本地不一致"; exit 1; }',
    '  echo "[build-runner] 已应用本地改动补丁"',
    'fi',
  ].join('\n')
}
