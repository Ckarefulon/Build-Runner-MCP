/**
 * Tests for workspace path diagnosis.
 *
 * The field report: a directory that WAS a git worktree was rejected with
 * "快照模式要求本地目录是 git 工作区". The boolean check could not distinguish a
 * missing directory (temp dirs are cleaned up) from a permission problem, a
 * spawn failure, or a genuine non-repo — so the caller was told to check their
 * path when the path was fine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { inspectGitRepo, isGitRepo } from '../src/workspace.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'br-gitcheck-'))
  const git = args =>
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] })
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.t'])
  git(['config', 'user.name', 't'])
  writeFileSync(join(dir, 'a.txt'), 'a\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])
  return dir
}

test('a real repository is accepted', () => {
  const dir = makeRepo()
  try {
    assert.deepEqual(inspectGitRepo(dir), { ok: true })
    assert.equal(isGitRepo(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing directory reports not-found, not "not a repo"', () => {
  const gone = join(tmpdir(), `br-gone-${Date.now().toString(36)}`)
  const result = inspectGitRepo(gone)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-found')
  // This is the distinction that matters: a temp directory that was cleaned up
  // must not be described as "not a git working tree".
  assert.match(result.detail, /不存在/)
})

test('a plain directory reports not-a-repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-plain-'))
  try {
    const result = inspectGitRepo(dir)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-a-repo')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file (not a directory) is rejected with its own reason', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-file-'))
  try {
    const file = join(dir, 'f.txt')
    writeFileSync(file, 'x')
    const result = inspectGitRepo(file)
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-a-directory')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an empty path is rejected without touching the filesystem', () => {
  const result = inspectGitRepo('')
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'missing-path')
})

test('a git worktree inside TEMP is accepted', () => {
  // The user's actual situation: `git worktree add` under %TEMP%.
  const main = makeRepo()
  const wt = join(tmpdir(), `br-wt-${Date.now().toString(36)}`)
  try {
    execFileSync('git', ['worktree', 'add', '-q', '-b', 'snap', wt], {
      cwd: main,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    const result = inspectGitRepo(wt)
    assert.equal(result.ok, true, `worktree rejected: ${JSON.stringify(result)}`)
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], {
        cwd: main,
        stdio: ['ignore', 'ignore', 'ignore'],
      })
    } catch {
      /* ignore */
    }
    rmSync(main, { recursive: true, force: true })
    rmSync(wt, { recursive: true, force: true })
  }
})

test('a subdirectory of a repo is accepted', () => {
  const dir = makeRepo()
  try {
    const sub = join(dir, 'nested', 'deeper')
    mkdirSync(sub, { recursive: true })
    assert.equal(inspectGitRepo(sub).ok, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
