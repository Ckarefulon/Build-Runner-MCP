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

export function isGitRepo(dir) {
  try {
    execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
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
