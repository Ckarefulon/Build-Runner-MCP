/**
 * Local change collection: figure out exactly what differs from a git ref
 * WITHOUT hashing or reading the whole working tree.
 *
 * This is the point of the whole workspace feature. A 5000-file repository with
 * 3 edited files must cost 3 file reads, not 5000. `git status` already knows
 * the answer — it stats the tree and reports only what moved — so the only work
 * left is reading the handful of paths it names.
 *
 * Two safety rules that matter more than speed:
 *
 *  - Only files git can SEE are collected. Anything `.gitignore` excludes is
 *    invisible to `git status`, which is deliberate: build outputs and secrets
 *    must never be uploaded just because they happen to sit in the folder.
 *  - Deletions are reported too, so the remote build sees the tree the way the
 *    author sees it rather than a superset with stale files left behind.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BUFFER = 256 * 1024 * 1024

export class GitError extends Error {
  constructor(message, { command } = {}) {
    super(message)
    this.name = 'GitError'
    this.command = command
  }
}

/**
 * Check that a directory is a git working tree, returning WHY when it is not.
 *
 * The previous boolean version swallowed every failure, so three very different
 * situations were indistinguishable to the caller:
 *   - the directory does not exist / was cleaned up,
 *   - git could not be spawned (PATH, permissions, sandbox),
 *   - the directory is simply not a repository.
 *
 * All three surfaced as "快照模式要求本地目录是 git 工作区", which sends the caller
 * looking at their path when the real cause was something else entirely.
 *
 * @returns {{ok:true} | {ok:false, reason:string, detail:string}}
 */
export function inspectGitRepo(dir) {
  if (typeof dir !== 'string' || dir.trim() === '') {
    return { ok: false, reason: 'missing-path', detail: 'workspaceDir 为空' }
  }
  let stat = null
  try {
    stat = statSync(dir)
  } catch (error) {
    const code = error?.code ?? ''
    if (code === 'ENOENT') {
      return { ok: false, reason: 'not-found', detail: `目录不存在：${dir}` }
    }
    return {
      ok: false,
      reason: 'unreadable',
      detail: `无法访问 ${dir}：${code || error.message}`,
    }
  }
  if (!stat.isDirectory()) {
    return { ok: false, reason: 'not-a-directory', detail: `不是目录：${dir}` }
  }

  try {
    const out = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (out.trim() !== 'true') {
      return {
        ok: false,
        reason: 'bare-or-nested',
        detail: `${dir} 在 git 仓库内但不是工作树根（可能是 .git 目录或裸仓库内部）`,
      }
    }
    return { ok: true }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      // git itself never ran: PATH, permission, or sandbox.
      return {
        ok: false,
        reason: 'git-unavailable',
        detail:
          `无法启动 git（cwd=${dir}）。` +
          '通常是 git 不在 PATH，或该进程没有访问此目录的权限。',
      }
    }
    const stderr = String(error?.stderr ?? '').trim()
    return {
      ok: false,
      reason: 'not-a-repo',
      detail: `${dir} 不是 git 工作区${stderr ? `：${stderr.split('\n')[0]}` : ''}`,
    }
  }
}

export function isGitRepo(dir) {
  return inspectGitRepo(dir).ok
}

function git(dir, args, { buffer = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: dir,
      encoding: buffer ? 'buffer' : 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = error.stderr ? error.stderr.toString().slice(0, 300) : error.message
    throw new GitError(`git ${args.join(' ')} 失败：${detail}`, { command: args.join(' ') })
  }
}

export function repoInfo(dir) {
  const toplevel = git(dir, ['rev-parse', '--show-toplevel']).trim()
  const head = git(dir, ['rev-parse', 'HEAD']).trim()
  let branch = ''
  try {
    branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
  } catch {
    branch = 'HEAD'
  }
  let remote = ''
  try {
    remote = git(dir, ['config', '--get', 'remote.origin.url']).trim()
  } catch {
    remote = ''
  }
  return { toplevel, head, branch, remote }
}

/** Resolve `origin` URL into { owner, repo } when possible. */
export function parseRemote(remote) {
  if (typeof remote !== 'string' || remote === '') return null
  const ssh = remote.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (ssh) {
    const parts = ssh[2].replace(/\.git$/, '').split('/')
    if (parts.length === 2) return { owner: parts[0], repo: parts[1] }
  }
  const https = remote.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?\/?$/)
  if (https) {
    const parts = https[1].replace(/\.git$/, '').split('/')
    if (parts.length >= 2) return { owner: parts[parts.length - 2], repo: parts[parts.length - 1] }
  }
  return null
}

/**
 * Parse `git status --porcelain=v1 -z`.
 *
 * The -z form is used on purpose: the default output quotes and escapes
 * non-ASCII paths with C-style escapes, which silently corrupts any filename
 * containing Chinese characters or a backslash. -z emits raw bytes separated by
 * NUL, and renames come as "<new>\0<old>".
 */
export function parseStatusZ(buffer) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '')
  const parts = text.split('\u0000').filter(part => part !== '')
  const changes = []
  for (let i = 0; i < parts.length; i += 1) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const indexStatus = entry[0]
    const worktreeStatus = entry[1]
    const path = entry.slice(3)
    const isRename = indexStatus === 'R' || indexStatus === 'C'
    // A rename/copy entry is followed by a separate NUL-terminated source path.
    const from = isRename ? parts[++i] : null
    let kind = 'modified'
    if (indexStatus === '?' && worktreeStatus === '?') kind = 'added'
    else if (indexStatus === 'D' || worktreeStatus === 'D') kind = 'deleted'
    else if (isRename) kind = 'renamed'
    else if (indexStatus === 'A') kind = 'added'
    changes.push({ path, kind, from, indexStatus, worktreeStatus })
  }
  return changes
}

/** Files git ignores cannot appear in a commit, so they must not be uploaded. */
export function isIgnoredByPolicy(path) {
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some(segment => segment === 'node_modules' || segment === '.git')) return true
  return false
}

/**
 * Collect the working tree's divergence from HEAD.
 *
 * @returns {{changes:Array, head:string, toplevel:string, branch:string, binary:boolean}}
 */
export function collectChanges(dir) {
  if (!isGitRepo(dir)) {
    throw new GitError(`不是 git 仓库：${dir}。快照模式需要目标目录是一个 git 工作区。`)
  }
  const { toplevel, head, branch } = repoInfo(dir)
  const raw = git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { buffer: true })
  const parsed = parseStatusZ(raw)

  const changes = []
  for (const change of parsed) {
    if (isIgnoredByPolicy(change.path)) continue
    const absolute = join(toplevel, change.path)
    if (change.kind === 'deleted') {
      changes.push({ path: change.path.replace(/\\/g, '/'), kind: 'deleted' })
      continue
    }
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      // Reported by git but gone from disk (e.g. deleted while staging).
      changes.push({ path: change.path.replace(/\\/g, '/'), kind: 'deleted' })
      continue
    }
    if (!stats.isFile()) continue
    const content = readFileSync(absolute)
    const normalized = change.path.replace(/\\/g, '/')
    changes.push({
      path: normalized,
      kind: change.kind,
      from: change.from ? change.from.replace(/\\/g, '/') : null,
      content,
      size: content.length,
    })
  }

  return { changes, head, toplevel, branch }
}

/** Number of files git tracks, used to judge whether a diff is suspicious. */
export function trackedFileCount(dir) {
  try {
    const out = execFileSync('git', ['ls-files'], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.split('\n').filter(line => line.trim() !== '').length
  } catch {
    return 0
  }
}

/** Whether the local repo contains a given commit (needed before diffing it). */
export function hasCommit(dir, sha) {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * Try to obtain a commit the local clone does not have yet.
 *
 * A workspace snapshot diffs against the REMOTE base, and a clone that has not
 * fetched recently may not contain it. Asking the user to run `git fetch`
 * themselves turns a solvable situation into a failure, so attempt it here.
 * Never fatal: if the fetch fails (no network, auth, read-only remote) the
 * caller still gets `false` and can produce a precise error.
 */
export function fetchCommit(dir, sha, { remote = 'origin', timeoutMs = 30000 } = {}) {
  if (hasCommit(dir, sha)) return true
  const attempts = [
    ['fetch', '--depth=1', remote, sha],
    ['fetch', remote, sha],
    ['fetch', remote],
  ]
  for (const args of attempts) {
    try {
      execFileSync('git', args, {
        cwd: dir,
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: timeoutMs,
      })
      if (hasCommit(dir, sha)) return true
    } catch {
      // try the next strategy
    }
  }
  return hasCommit(dir, sha)
}

/**
 * Files that differ between the local HEAD and a KNOWN remote commit.
 *
 * Why this exists: `git status` only reports changes relative to the local HEAD.
 * A commit that exists locally but was never pushed is invisible to it, so a
 * workspace snapshot built on the remote branch silently omits it — the release
 * then ships code that predates the fix while looking perfectly successful.
 *
 * `git diff --name-status -z <remoteSha>` compares the remote commit against the
 * local working tree in one shot, which is exactly the relationship a snapshot
 * needs. baseSha must be reachable locally; callers fetch it first.
 *
 * @returns {{changes:Array, head:string, baseSha:string, toplevel:string}}
 */
export function collectChangesAgainst(dir, baseSha) {
  if (!isGitRepo(dir)) {
    throw new GitError(`不是 git 仓库：${dir}`)
  }
  const { toplevel, head } = repoInfo(dir)

  const changes = []
  const seen = new Set()

  // `git diff <commit>` compares the commit against tracked paths only. A file
  // the agent just created is UNTRACKED, so it would be missing from the diff —
  // and an agent that writes a new file and immediately builds it would get a
  // snapshot without that file. Untracked files are therefore collected
  // separately and merged in.
  const raw = git(dir, ['diff', '--name-status', '-z', '--no-renames', baseSha, '--'], {
    buffer: true,
  })
  const parts = Buffer.from(raw).toString('utf8').split('\u0000').filter(part => part !== '')
  // --name-status -z emits: <STATUS>\0<path>\0 (one entry per file).
  for (let i = 0; i < parts.length - 1; i += 2) {
    const status = parts[i].trim()
    const path = parts[i + 1]
    if (!status || !path) continue
    const normalized = path.replace(/\\/g, '/')
    if (isIgnoredByPolicy(normalized)) continue

    if (status.startsWith('D')) {
      changes.push({ path: normalized, kind: 'deleted' })
      seen.add(normalized)
      continue
    }
    const absolute = join(toplevel, path)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      changes.push({ path: normalized, kind: 'deleted' })
      seen.add(normalized)
      continue
    }
    if (!stats.isFile()) continue
    const content = readFileSync(absolute)
    changes.push({
      path: normalized,
      kind: status.startsWith('A') ? 'added' : 'modified',
      content,
      size: content.length,
    })
    seen.add(normalized)
  }

  // Untracked files, respecting .gitignore (build outputs and secrets stay home).
  const untrackedRaw = git(dir, ['ls-files', '--others', '--exclude-standard', '-z'], {
    buffer: true,
  })
  for (const path of Buffer.from(untrackedRaw).toString('utf8').split('\u0000')) {
    if (path === '') continue
    const normalized = path.replace(/\\/g, '/')
    if (seen.has(normalized) || isIgnoredByPolicy(normalized)) continue
    const absolute = join(toplevel, path)
    let stats
    try {
      stats = statSync(absolute)
    } catch {
      continue
    }
    if (!stats.isFile()) continue
    const content = readFileSync(absolute)
    changes.push({ path: normalized, kind: 'added', content, size: content.length })
    seen.add(normalized)
  }

  return { changes, head, baseSha, toplevel }
}

/** Short human summary used in tool output. */
export function summarizeChanges(changes) {
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0 }
  let bytes = 0
  for (const change of changes) {
    counts[change.kind] = (counts[change.kind] ?? 0) + 1
    bytes += change.size ?? 0
  }
  return { ...counts, total: changes.length, bytes }
}
