/**
 * Regression tests for the "snapshot was empty" class of bug.
 *
 * The failure being locked down: a caller had committed a fix locally but not
 * pushed it. `git status` reported a clean tree, so the snapshot was empty, and
 * the build silently ran on the remote's OLDER commit. The release looked
 * successful while shipping none of the fix.
 *
 * The invariant: when the local HEAD differs from the remote base, the diff
 * against the REMOTE commit must surface those files — not an empty set.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { collectChanges, collectChangesAgainst, hasCommit } from '../src/workspace.js'

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'br-ahead-'))
  const git = args =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.t'])
  git(['config', 'user.name', 't'])
  git(['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.js'), 'v1\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'base'])
  return { dir, git }
}

test('a clean tree against its own HEAD reports nothing', () => {
  const { dir, git } = makeRepo()
  try {
    const head = git(['rev-parse', 'HEAD']).trim()
    assert.equal(collectChanges(dir).changes.length, 0)
    // Diffing the same commit must also be empty.
    assert.equal(collectChangesAgainst(dir, head).changes.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a COMMITTED but unpushed change is invisible to git status', () => {
  const { dir, git } = makeRepo()
  try {
    const base = git(['rev-parse', 'HEAD']).trim()
    writeFileSync(join(dir, 'src', 'a.js'), 'v2-FIXED\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'the fix'])

    // This is the trap: git status says clean, so a naive snapshot is empty.
    assert.equal(collectChanges(dir).changes.length, 0)

    // Diffing against the remote base must reveal the fix.
    const against = collectChangesAgainst(dir, base)
    assert.equal(against.changes.length, 1)
    assert.equal(against.changes[0].path, 'src/a.js')
    assert.equal(against.changes[0].kind, 'modified')
    assert.match(against.changes[0].content.toString(), /v2-FIXED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('diff against remote covers committed AND uncommitted edits together', () => {
  const { dir, git } = makeRepo()
  try {
    const base = git(['rev-parse', 'HEAD']).trim()
    // one committed change...
    writeFileSync(join(dir, 'src', 'a.js'), 'committed\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'c1'])
    // ...and one still in the working tree
    writeFileSync(join(dir, 'src', 'b.js'), 'uncommitted\n')

    const against = collectChangesAgainst(dir, base)
    const paths = against.changes.map(c => c.path).sort()
    assert.deepEqual(paths, ['src/a.js', 'src/b.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('new files and deletions are both represented', () => {
  const { dir, git } = makeRepo()
  try {
    const base = git(['rev-parse', 'HEAD']).trim()
    writeFileSync(join(dir, 'src', 'new.js'), 'new\n')
    rmSync(join(dir, 'src', 'a.js'))
    git(['add', '-A'])
    git(['commit', '-qm', 'add and delete'])

    const against = collectChangesAgainst(dir, base)
    const byPath = Object.fromEntries(against.changes.map(c => [c.path, c.kind]))
    assert.equal(byPath['src/new.js'], 'added')
    assert.equal(byPath['src/a.js'], 'deleted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('non-ASCII paths survive the diff round trip', () => {
  const { dir, git } = makeRepo()
  try {
    const base = git(['rev-parse', 'HEAD']).trim()
    mkdirSync(join(dir, '中文目录'), { recursive: true })
    writeFileSync(join(dir, '中文目录', '文件.txt'), '中文\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'cn'])

    const against = collectChangesAgainst(dir, base)
    assert.equal(against.changes.length, 1)
    assert.equal(against.changes[0].path, '中文目录/文件.txt')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('hasCommit distinguishes present from absent commits', () => {
  const { dir, git } = makeRepo()
  try {
    const head = git(['rev-parse', 'HEAD']).trim()
    assert.equal(hasCommit(dir, head), true)
    assert.equal(hasCommit(dir, '0'.repeat(40)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a shallow/unknown base is reported, not silently treated as empty', () => {
  const { dir } = makeRepo()
  try {
    // A caller that never fetched the base must get a chance to detect it via
    // hasCommit before diffing, instead of an empty change list.
    assert.equal(hasCommit(dir, '1'.repeat(40)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
