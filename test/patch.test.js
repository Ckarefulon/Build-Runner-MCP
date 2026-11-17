/**
 * Regression test for the "unpushed commit produces an empty patch" bug.
 *
 * The patch builder used to seed its temporary index from the BASE commit and
 * then `git add -A`. With a clean working tree that yields an empty patch, even
 * though the local HEAD has commits the base lacks — so a "commit but don't
 * push" branch silently arrived in the cloud as the old code.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { createWorkspacePatch } from '../src/patch.js'

function gitIn(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'br-unpushed-'))
  gitIn(dir, ['init', '-q'])
  gitIn(dir, ['config', 'user.email', 't@t.t'])
  gitIn(dir, ['config', 'user.name', 't'])
  gitIn(dir, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.js'), 'base\n')
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '-qm', 'base'])
  return dir
}

test('a committed but unpushed change is included in the patch', () => {
  const dir = makeRepo()
  try {
    const base = gitIn(dir, ['rev-parse', 'HEAD']).trim()

    // Commit on a new branch and push nothing: working tree is CLEAN.
    gitIn(dir, ['checkout', '-q', '-b', 'chore/never-pushed'])
    writeFileSync(join(dir, 'src', 'a.js'), 'unpushed change\n')
    writeFileSync(join(dir, 'src', 'new.js'), 'brand new\n')
    gitIn(dir, ['add', '-A'])
    gitIn(dir, ['commit', '-qm', 'the fix'])
    assert.equal(gitIn(dir, ['status', '--porcelain']).trim(), '', 'tree must be clean')

    const { patch, files } = createWorkspacePatch(dir, base)
    assert.ok(patch.length > 0, 'patch must not be empty for an unpushed commit')

    const text = patch.toString('utf8')
    assert.match(text, /src\/a\.js/, 'modified file must appear')
    assert.match(text, /src\/new\.js/, 'new file must appear')

    const paths = files.map(f => f.path).sort()
    assert.deepEqual(paths, ['src/a.js', 'src/new.js'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unpushed commits and working-tree edits are both captured', () => {
  const dir = makeRepo()
  try {
    const base = gitIn(dir, ['rev-parse', 'HEAD']).trim()

    gitIn(dir, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(dir, 'src', 'committed.js'), 'committed\n')
    gitIn(dir, ['add', '-A'])
    gitIn(dir, ['commit', '-qm', 'committed work'])
    // …plus an uncommitted file on top.
    writeFileSync(join(dir, 'src', 'working.js'), 'working\n')

    const { patch } = createWorkspacePatch(dir, base)
    const text = patch.toString('utf8')
    assert.match(text, /src\/committed\.js/)
    assert.match(text, /src\/working\.js/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a clean tree at its own HEAD yields an empty patch', () => {
  const dir = makeRepo()
  try {
    const base = gitIn(dir, ['rev-parse', 'HEAD']).trim()
    const { patch, files } = createWorkspacePatch(dir, base)
    assert.equal(patch.length, 0)
    assert.deepEqual(files, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the patch can be applied to a checkout of the base to reproduce the tree', () => {
  const dir = makeRepo()
  try {
    const base = gitIn(dir, ['rev-parse', 'HEAD']).trim()
    gitIn(dir, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(join(dir, 'src', 'a.js'), 'changed\n')
    gitIn(dir, ['add', '-A'])
    gitIn(dir, ['commit', '-qm', 'change'])

    const { patch } = createWorkspacePatch(dir, base)

    // Fresh clone at the base, then apply.
    const target = mkdtempSync(join(tmpdir(), 'br-apply-'))
    execFileSync('git', ['clone', '-q', dir, target], { stdio: ['ignore', 'ignore', 'pipe'] })
    gitIn(target, ['checkout', '-q', base])
    execFileSync('git', ['apply', '--binary', '-'], { cwd: target, input: patch })
    assert.equal(readFileSync(join(target, 'src', 'a.js'), 'utf8').trim(), 'changed')
    rmSync(target, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
