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
  // autocrlf=false matters on Windows: otherwise a LF file is re-encoded to CRLF
  // and the patch would push CRLF bytes into a Linux build, silently changing
  // the content it claims to preserve.
  const env = {
    GIT_INDEX_FILE: indexFile,
    GIT_CONFIG_NOSYSTEM: '1',
  }

  try {
    git(dir, ['config', 'core.autocrlf', 'false'], { env })
    // Seed the temp index from the BASE commit, not HEAD: that makes the diff
    // represent "base -> working tree", which is exactly what the cloud needs.
    git(dir, ['read-tree', baseSha], { env })
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
