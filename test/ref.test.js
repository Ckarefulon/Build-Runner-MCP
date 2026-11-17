/**
 * Tests for the two field-reported problems.
 *
 * 1. A 502 through an inspecting proxy. The retry policy has to be safe: a
 *    content-addressed blob upload may be retried, but a commit may not, or a
 *    lost response would create a second commit.
 * 2. A branch that exists only locally (committed, never pushed) used to be
 *    rejected outright. It must be remapped onto an existing base instead, with
 *    the caller told what happened.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { localGitBranchExists } from '../src/runner.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

test('detects a branch that exists only locally', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-branch-'))
  const git = args =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  try {
    git(['init', '-q'])
    git(['config', 'user.email', 't@t.t'])
    git(['config', 'user.name', 't'])
    git(['commit', '-qm', 'init', '--allow-empty'])
    git(['branch', 'chore/437-bump-6.0.3'])

    assert.equal(localGitBranchExists(dir, 'chore/437-bump-6.0.3'), true)
    assert.equal(localGitBranchExists(dir, 'does-not-exist'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing local branch is reported as absent, not as an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'br-nobranch-'))
  try {
    // Not a git repo at all: must return false rather than throw, because the
    // caller only uses this to decide whether a ref can be remapped.
    assert.equal(localGitBranchExists(dir, 'anything'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('verifyRef remaps a local-only branch instead of rejecting it', async () => {
  const { verifyRef } = await import('../src/runner.js')
  const { GitHubError } = await import('../src/github.js')

  // Every branch lookup 404s; the repo reports `dev` as its default branch.
  const client = {
    getBranch: async () => {
      throw new GitHubError('Not Found', { status: 404 })
    },
    getRepo: async () => ({ default_branch: 'dev' }),
  }

  const result = await verifyRef(client, {
    owner: 'o',
    repo: 'r',
    ref: 'chore/437-bump-6.0.3',
    localBranchExists: true,
  })

  assert.equal(result.ref, 'dev', 'must fall back to the default branch')
  assert.equal(result.remappedFrom, 'chore/437-bump-6.0.3')
  assert.match(result.note, /只存在于本地/)
})

test('verifyRef still fails loudly for an unknown ref with no local branch', async () => {
  const { verifyRef } = await import('../src/runner.js')
  const { GitHubError } = await import('../src/github.js')

  const client = {
    getBranch: async () => {
      throw new GitHubError('Not Found', { status: 404 })
    },
    getRepo: async () => ({ default_branch: 'dev' }),
  }

  await assert.rejects(
    () => verifyRef(client, { owner: 'o', repo: 'r', ref: 'nope', localBranchExists: false }),
    error => {
      assert.match(error.message, /找不到分支/)
      // The message must tell the caller how to proceed, not just that it failed.
      assert.match(error.message, /workspaceDir/)
      return true
    }
  )
})

test('an existing remote branch is returned unchanged', async () => {
  const { verifyRef } = await import('../src/runner.js')
  const client = {
    getBranch: async () => ({ name: 'dev' }),
    getRepo: async () => ({ default_branch: 'main' }),
  }
  const result = await verifyRef(client, { owner: 'o', repo: 'r', ref: 'dev' })
  assert.equal(result.ref, 'dev')
  assert.equal(result.remappedFrom, undefined)
})
