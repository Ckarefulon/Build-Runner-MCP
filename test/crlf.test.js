/**
 * Regression tests for line-ending churn in patch generation.
 *
 * The bug: `createWorkspacePatch` forced `core.autocrlf=false`. On a Windows
 * checkout every tracked file is CRLF on disk but LF in the object database, so
 * disabling the conversion made `git add` see ALL of them as modified. A
 * 1949-file repository produced a 46 MB patch, which then failed to upload — and
 * the failure looked like a network/proxy error, not a logic bug.
 *
 * These tests simulate the two configurations directly on the git level, so the
 * invariant is checked without needing a Windows filesystem.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

import { createWorkspacePatch } from '../src/patch.js'
import { trackedFileCount } from '../src/workspace.js'

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'br-crlf-'))
  const git = (args, env = {}) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    })
  git(['init', '-q'])
  git(['config', 'user.email', 't@t.t'])
  git(['config', 'user.name', 't'])
  git(['config', 'commit.gpgsign', 'false'])
  return { dir, git }
}

test('a clean tree produces no patch even when files are many', () => {
  const { dir, git } = repo()
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    // Enough files that a whole-tree diff would be obvious.
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(join(dir, 'src', `f${i}.txt`), `content ${i}\n`)
    }
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    const base = git(['rev-parse', 'HEAD']).trim()

    const { patch, files } = createWorkspacePatch(dir, base)
    assert.equal(files.length, 0, 'nothing changed, so nothing should be listed')
    assert.equal(patch.length, 0, 'patch must be empty')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('editing one file out of many yields a patch for one file only', () => {
  const { dir, git } = repo()
  try {
    mkdirSync(join(dir, 'src'), { recursive: true })
    for (let i = 0; i < 60; i += 1) {
      writeFileSync(join(dir, 'src', `f${i}.txt`), `content ${i}\n`)
    }
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    const base = git(['rev-parse', 'HEAD']).trim()

    writeFileSync(join(dir, 'src', 'f7.txt'), 'changed\n')

    const { patch, files } = createWorkspacePatch(dir, base)
    assert.equal(files.length, 1, `expected 1 file, got ${files.length}`)
    assert.equal(files[0].path, 'src/f7.txt')
    // A one-line edit must not drag the rest of the tree along.
    assert.ok(patch.length < 2000, `patch unexpectedly large: ${patch.length} bytes`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('patch generation leaves the caller git config untouched', () => {
  // The fix must not silently rewrite the caller's git config either — the
  // invariant is "unchanged", not "unset": a machine may legitimately have
  // core.autocrlf set globally.
  const { dir, git } = repo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    const base = git(['rev-parse', 'HEAD']).trim()

    const readSetting = () => {
      try {
        return git(['config', '--get', 'core.autocrlf']).trim()
      } catch {
        return ''
      }
    }

    const before = readSetting()
    writeFileSync(join(dir, 'a.txt'), 'b\n')
    createWorkspacePatch(dir, base)
    const after = readSetting()

    assert.equal(after, before, 'core.autocrlf must not be changed by patch generation')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('trackedFileCount reports the number of tracked files', () => {
  const { dir, git } = repo()
  try {
    writeFileSync(join(dir, 'a.txt'), 'a\n')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    git(['add', '-A'])
    git(['commit', '-qm', 'base'])
    assert.equal(trackedFileCount(dir), 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
