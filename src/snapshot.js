/**
 * Workspace support: carry local changes to the cloud WITHOUT touching the
 * target repository.
 *
 * History of this module, because the constraint is not obvious:
 *
 *   v1 published the working tree as a commit on a `build-runner` branch inside
 *      the TARGET repository. It worked and only uploaded the diff, but it left
 *      a branch in a repository the caller never asked to modify.
 *
 *   v2 (this version) sends a PATCH instead. Nothing is created in the target
 *      repository at all: the runner checks out the caller's own branch, applies
 *      the patch, and builds. The target repo is byte-identical afterwards.
 *
 * Why not "build a branch in the Build-Runner repo"? A commit's parent must live
 * in the same repository — GitHub rejects cross-repo parents with
 * HTTP 422 "Parent SHA does not exist or is not a commit object". Without the
 * real parent, `git describe` and `git rev-list --count` break, and this project
 * derives Android `versionCode` from commit count. A wrong versionCode makes the
 * APK uninstallable, so that trade is not acceptable.
 *
 * The patch keeps every property the branch approach had:
 *   - only changed bytes travel (no full-repo upload);
 *   - committed-but-unpushed edits, uncommitted edits, new files and deletions
 *     are all included;
 *   - .gitignore rules still apply, so build outputs and secrets never leave.
 */

import { createWorkspacePatch, publishPatchToEngine } from './patch.js'
import { collectChanges, parseRemote, summarizeChanges, isGitRepo, repoInfo } from './workspace.js'
import { parseSlug } from './github.js'

// Inline dispatch inputs are capped near 61 KiB (measured), so anything larger
// travels via a disposable branch in the engine repo.
const INLINE_PATCH_LIMIT = 48000

/** Kept for API compatibility with earlier callers. */
export function buildBranchName(prefix = 'build-runner') {
  return prefix
}

/**
 * Prepare the local tree for a remote build.
 *
 * Returns a patch plus metadata; the workflow applies it after checkout. No ref,
 * branch or commit is created anywhere.
 *
 * @returns {{patch:Buffer|null, changed:number, summary:object, baseSha:string,
 *            localHead:string, aheadOfRemote:boolean, files:Array}}
 */
export async function prepareWorkspace(client, options) {
  const { dir, repo, baseRef, dryRun = false, engine } = options

  const target = parseSlug(repo)
  if (!target) throw new Error(`无法解析目标仓库：${repo}`)
  if (!isGitRepo(dir)) throw new Error(`快照模式要求本地目录是 git 工作区：${dir}`)

  const info = repoInfo(dir)
  const remoteSlug = parseRemote(info.remote)
  if (
    remoteSlug &&
    `${remoteSlug.owner}/${remoteSlug.repo}`.toLowerCase() !==
      `${target.owner}/${target.repo}`.toLowerCase()
  ) {
    console.error(
      `[build-runner] 注意：本地 origin 是 ${remoteSlug.owner}/${remoteSlug.repo}，` +
        `目标仓库是 ${target.owner}/${target.repo}。补丁将应用到目标仓库的检出上。`
    )
  }

  // The base is the REMOTE commit the caller's branch points at. Diffing against
  // it (rather than against local HEAD) is what captures committed-but-unpushed
  // work: `git status` cannot see those.
  const baseCommit = await client.resolveCommit(target.owner, target.repo, baseRef)

  const { patch, files } = createWorkspacePatch(dir, baseCommit.sha)
  const changed = files.length

  // Summarise from the file list so the caller sees the same shape as before.
  const summary = summarizeChanges(
    files.map(file => ({ kind: file.kind, size: 0 }))
  )

  const result = {
    repo: `${target.owner}/${target.repo}`,
    baseRef,
    baseSha: baseCommit.sha,
    localHead: info.head,
    aheadOfRemote: info.head !== baseCommit.sha,
    changed,
    files,
    summary,
    patchBytes: patch.length,
  }

  if (changed === 0) {
    return {
      ...result,
      patch: null,
      note: '本地与远端基准一致，无需应用补丁，直接构建 baseRef。',
    }
  }

  if (dryRun) {
    return { ...result, patch: null, dryRun: true }
  }

  // Decide the transport: a small patch can ride in the dispatch input, but a
  // realistic one exceeds the ~61 KiB limit, so it goes to a dedicated branch in
  // the ENGINE repo (never the target repo).
  if (patch.length <= INLINE_PATCH_LIMIT || !engine) {
    return { ...result, patch, patchRef: null, patchInline: true }
  }

  // One FIXED branch per target repository, overwritten every run.
  //
  // Deliberately not a unique-per-run name: a fresh branch each time means the
  // engine repo accumulates refs forever and forces a cleanup step at the end of
  // every job (an extra container step, ~10s, to delete something nobody looks
  // at). Reusing one branch per target keeps concurrency safe — the workflow's
  // concurrency group is keyed on repo+ref, so two builds of the same target can
  // never race on it — while leaving no garbage behind.
  const scope = `${target.owner}-${target.repo}`.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60)
  const branch = `br-patch/${scope}`
  await publishPatchToEngine(client, {
    owner: engine.owner,
    repo: engine.repo,
    branch,
    patch,
  })
  return { ...result, patch: null, patchRef: branch, patchInline: false }
}

/**
 * Report what a snapshot would contain, without building a patch.
 * Cheap enough for a "what am I about to send?" check.
 */
export async function describeWorkspace(client, { dir, repo, baseRef }) {
  const target = parseSlug(repo)
  if (!target) throw new Error(`无法解析目标仓库：${repo}`)
  const baseCommit = await client.resolveCommit(target.owner, target.repo, baseRef)
  const status = collectChanges(dir)
  return {
    repo: `${target.owner}/${target.repo}`,
    baseRef,
    baseSha: baseCommit.sha,
    localHead: status.head,
    statusChanges: status.changes.length,
    summary: summarizeChanges(status.changes),
  }
}

/** Legacy shape kept so older call sites do not crash during transition. */
export async function inspectBuildBranch() {
  return {
    exists: false,
    note: '快照不再使用分支：改动以补丁形式在云端应用，目标仓库不会产生任何分支。',
  }
}

export async function resetBuildBranch() {
  return {
    note: '无需清理：补丁模式不在任何仓库创建分支。',
  }
}

export async function publishWorkspace(client, options) {
  const prepared = await prepareWorkspace(client, options)
  return {
    ...prepared,
    // Nothing is published to a branch anymore; the patch travels with the run.
    published: prepared.changed > 0,
    branch: null,
  }
}
