/**
 * Publish the local working tree to a build branch on the target repository.
 *
 * The insight this is built on: the content a build needs is usually ALREADY on
 * GitHub. Re-uploading a whole repository to build three edited files is pure
 * waste — both in bandwidth and in API calls.
 *
 * So instead:
 *
 *   1. Resolve the base commit on GitHub (the branch the AI branched from).
 *   2. Ask git locally which paths differ from HEAD (cheap: `git status` only
 *      stats, it does not hash a 5000-file tree).
 *   3. Upload ONLY those blobs.
 *   4. Ask GitHub to build a tree from `base_tree` = the base commit's tree plus
 *      those entries. GitHub stitches the untouched files in server-side.
 *   5. Create a commit whose parent is the real base commit, and point a
 *      permanent build branch at it.
 *
 * Step 5 is what makes the result trustworthy: because the parent is the real
 * base commit, `git describe`, `git rev-list --count` and version-code-derived
 * build numbers inside the build see the true history. A tarball upload could
 * never do that.
 */

import { collectChanges, parseRemote, summarizeChanges, isGitRepo, repoInfo } from './workspace.js'
import { parseSlug } from './github.js'

/** Deterministic branch name so repeated builds of one repo reuse it. */
export function buildBranchName(prefix = 'build-runner') {
  return prefix
}

/**
 * @param {object} client  GitHub client
 * @param {object} options
 * @param {string} options.dir        local git working directory
 * @param {string} options.repo       target repository (owner/name)
 * @param {string} options.baseRef    branch/tag/SHA the local tree is based on
 * @param {string} [options.branch]   build branch name to publish to
 * @param {string} [options.message]  commit message
 * @param {boolean} [options.dryRun]  collect + report without uploading
 */
export async function publishWorkspace(client, options) {
  const {
    dir,
    repo,
    baseRef,
    branch = buildBranchName(),
    message,
    dryRun = false,
    author = { name: 'build-runner', email: 'build-runner@users.noreply.github.com' },
  } = options

  const target = parseSlug(repo)
  if (!target) throw new Error(`无法解析目标仓库：${repo}`)

  if (!isGitRepo(dir)) {
    throw new Error(`快照模式要求本地目录是 git 工作区：${dir}`)
  }

  const info = repoInfo(dir)
  const remoteSlug = parseRemote(info.remote)
  if (
    remoteSlug &&
    `${remoteSlug.owner}/${remoteSlug.repo}`.toLowerCase() !==
      `${target.owner}/${target.repo}`.toLowerCase()
  ) {
    throw new Error(
      `本地仓库的 origin 是 ${remoteSlug.owner}/${remoteSlug.repo}，与目标 ${target.owner}/${target.repo} 不一致。` +
        '请确认 repo 参数，或检查目录是否选对。'
    )
  }

  const { changes } = collectChanges(dir)
  const summary = summarizeChanges(changes)

  // Resolve the base commit on the remote. Prefer the caller's ref so the
  // published commit sits on top of the branch the author actually worked from.
  const baseCommit = await client.resolveCommit(target.owner, target.repo, baseRef)

  if (changes.length === 0) {
    return {
      repo: `${target.owner}/${target.repo}`,
      branch,
      baseRef,
      baseSha: baseCommit.sha,
      sha: baseCommit.sha,
      ref: baseRef,
      changed: 0,
      summary,
      note: '工作区没有未提交的改动，直接使用 baseRef 构建。',
      published: false,
    }
  }

  if (dryRun) {
    return {
      repo: `${target.owner}/${target.repo}`,
      branch,
      baseRef,
      baseSha: baseCommit.sha,
      changed: changes.length,
      summary,
      files: changes.map(change => ({ path: change.path, kind: change.kind, size: change.size ?? 0 })),
      published: false,
      dryRun: true,
    }
  }

  // Upload only the blobs that changed. Unchanged files never leave the machine.
  const tree = []
  let uploadedBytes = 0
  for (const change of changes) {
    if (change.kind === 'deleted') {
      // A null sha removes the path from the base tree.
      tree.push({ path: change.path, mode: '100644', type: 'blob', sha: null })
      continue
    }
    const blob = await client.createBlob(target.owner, target.repo, change.content)
    uploadedBytes += change.size ?? 0
    tree.push({ path: change.path, mode: '100644', type: 'blob', sha: blob.sha })
  }

  const newTree = await client.createTree(target.owner, target.repo, {
    baseTree: baseCommit.tree.sha,
    tree,
  })

  const changedList = changes
    .map(change => `${change.kind[0]}:${change.path}`)
    .slice(0, 20)
    .join(', ')
  const commit = await client.createCommit(target.owner, target.repo, {
    message:
      message ??
      `build-runner: workspace snapshot (${summary.total} 处改动)\n\n` +
        `base: ${baseRef} @ ${baseCommit.sha.slice(0, 7)}\n` +
        `files: ${changedList}` +
        (changes.length > 20 ? ` ...(+${changes.length - 20})` : ''),
    tree: newTree.sha,
    parents: [baseCommit.sha],
    author,
  })

  await client.upsertRef(target.owner, target.repo, branch, commit.sha, { force: true })

  return {
    repo: `${target.owner}/${target.repo}`,
    branch,
    baseRef,
    baseSha: baseCommit.sha,
    sha: commit.sha,
    ref: branch,
    changed: changes.length,
    summary,
    uploadedBytes,
    published: true,
  }
}

/**
 * Keep the permanent build branch from accumulating garbage.
 *
 * The branch is reused on purpose (one branch per repo, not one per run), which
 * keeps Actions concurrency groups stable. The cost is that history grows, so
 * callers can reset it to the base commit when it gets long.
 */
export async function resetBuildBranch(client, { repo, baseRef, branch = buildBranchName() }) {
  const target = parseSlug(repo)
  if (!target) throw new Error(`无法解析目标仓库：${repo}`)
  const baseCommit = await client.resolveCommit(target.owner, target.repo, baseRef)
  await client.upsertRef(target.owner, target.repo, branch, baseCommit.sha, { force: true })
  return {
    repo: `${target.owner}/${target.repo}`,
    branch,
    sha: baseCommit.sha,
    note: '构建分支已重置到 baseRef',
  }
}

/** Inspect the build branch without changing anything. */
export async function inspectBuildBranch(client, { repo, branch = buildBranchName() }) {
  const target = parseSlug(repo)
  if (!target) throw new Error(`无法解析目标仓库：${repo}`)
  const ref = await client.tryGetRef(target.owner, target.repo, `heads/${branch}`)
  if (!ref) {
    return { repo: `${target.owner}/${target.repo}`, branch, exists: false }
  }
  const commit = await client.getCommit(target.owner, target.repo, ref.object.sha)
  return {
    repo: `${target.owner}/${target.repo}`,
    branch,
    exists: true,
    sha: commit.sha,
    parents: (commit.parents ?? []).map(parent => parent.sha),
    message: commit.message?.split('\n')[0],
    date: commit.committer?.date,
    url: `https://github.com/${target.owner}/${target.repo}/tree/${branch}`,
  }
}
