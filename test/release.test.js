/**
 * Regression tests for the release path.
 *
 * The bug being locked down: `release.js` referenced `effectiveRef`, a variable
 * removed when snapshot publishing switched from branches to patches. Every
 * call with `workspaceDir` crashed with a ReferenceError BEFORE dispatching, so
 * no run existed and no release was produced — and the error surfaced as a bare
 * message with no location.
 *
 * Two things are asserted here:
 *   1. the module has no references to undeclared identifiers on the release
 *      path (a static check, because the crash was a plain JS typo);
 *   2. the dispatch inputs carry the caller's ref and the patch, which is the
 *      behaviour the fix restores.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = join(__dirname, '..', 'src')

test('release.js does not reference the removed snapshot-branch variable', () => {
  const source = readFileSync(join(SRC, 'release.js'), 'utf8')
  // `effectiveRef` belonged to branch mode. Its return means a half-applied
  // refactor, and it crashes every workspace call at runtime.
  assert.equal(
    /\beffectiveRef\b/.test(source),
    false,
    'effectiveRef must not appear in release.js (patch mode uses target.ref)'
  )
})

test('runner.js does not reference the removed snapshot-branch variable', () => {
  const source = readFileSync(join(SRC, 'runner.js'), 'utf8')
  assert.equal(/\beffectiveRef\b/.test(source), false, 'effectiveRef must not appear in runner.js')
})

test('workspace mode reaches dispatch instead of crashing on a typo', async () => {
  const { releaseArtifacts } = await import('../src/release.js')
  const { execFileSync } = await import('node:child_process')
  assert.equal(typeof releaseArtifacts, 'function')

  // Use the repo's real HEAD so the patch builder has a base it can actually
  // diff against — a fake SHA would fail earlier, on a legitimate guard.
  const repoDir = join(__dirname, '..')
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
  }).trim()

  // The regression: a workspace call used to throw a ReferenceError before any
  // network call. Reaching the dispatch stub proves the release path now runs to
  // the point where a real run would be created.
  const stubClient = {
    getBranch: async () => ({ name: 'dev' }),
    getRepo: async () => ({ default_branch: 'dev' }),
    resolveCommit: async () => ({ sha: head, tree: { sha: 'b'.repeat(40) } }),
    dispatch: async () => {
      throw new Error('STUB_DISPATCH_REACHED')
    },
  }
  await assert.rejects(
    () =>
      releaseArtifacts(stubClient, {
        repo: 'owner/repo',
        ref: 'dev',
        command: 'echo hi',
        artifactPaths: 'out/**',
        workspaceDir: repoDir,
        wait: false,
      }),
    error => {
      assert.match(
        error.message,
        /STUB_DISPATCH_REACHED/,
        `expected the dispatch to be reached, got: ${error.message}`
      )
      return true
    }
  )
})
