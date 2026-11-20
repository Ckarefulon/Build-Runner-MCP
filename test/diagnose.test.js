/**
 * Tests for environment diagnosis.
 *
 * The problem this solves: a failing cloud build took many rounds to attribute,
 * because a missing dependency, an empty cache, an unreachable repository and a
 * genuine compile error all present as a truncated Gradle log. The diagnosis
 * answers those separately so the caller can stop guessing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDiagnosticScript, extractHints } from '../src/diagnose.js'

test('the script checks cache completeness, not just presence', () => {
  const script = buildDiagnosticScript()
  // An empty-but-present modules-2 is the exact state that makes `session` fail
  // while `run` succeeds: the directory exists, the dependencies do not.
  assert.match(script, /modules-2 子目录数/)
  assert.match(script, /build-cache-1/)
})

test('the script reports repository reachability with a timeout', () => {
  const script = buildDiagnosticScript()
  assert.match(script, /--max-time 6/, 'must not hang on an unreachable repo')
  assert.match(script, /repo1\.maven\.org/)
  assert.match(script, /dl\.google\.com/)
})

test('the script proves the cache offline', () => {
  // `--offline` is the decisive check: success means every declared dependency
  // is already on disk.
  const script = buildDiagnosticScript()
  assert.match(script, /--offline/)
  assert.match(script, /offline-config=/)
})

test('a fully healthy report produces encouraging hints', () => {
  const report = [
    'dirty  : 0 个文件未提交',
    '  modules-2 子目录数：812',
    '  200  https://repo1.maven.org/maven2/',
    'BUILD SUCCESSFUL in 34s',
    'offline-config=34s  （离线成功说明缓存完整）',
  ].join('\n')
  const hints = extractHints(report)
  assert.ok(hints.some(h => /缓存完整/.test(h)), `expected a cache-ok hint, got: ${hints.join(' | ')}`)
  assert.ok(!hints.some(h => /不可达/.test(h)), 'must not claim unreachable repos')
})

test('an empty module cache is called out', () => {
  const report = ['  modules-2 子目录数：0', 'BUILD SUCCESSFUL'].join('\n')
  const hints = extractHints(report)
  assert.ok(hints.some(h => /依赖缓存为空/.test(h)))
})

test('a timed-out repository is called out', () => {
  const report = ['  TIMEOUT  https://example.invalid/', 'offline-config=40s'].join('\n')
  const hints = extractHints(report)
  assert.ok(hints.some(h => /不可达/.test(h)))
})

test('uncommitted work is reported so the caller knows a patch is in play', () => {
  const report = ['dirty  : 7 个文件未提交', 'offline-config=50s'].join('\n')
  const hints = extractHints(report)
  assert.ok(hints.some(h => /7 个未提交文件/.test(h)))
})

test('a failing configuration phase is attributed to the code', () => {
  const report = ['dirty  : 0 个文件未提交', 'Something went wrong: compilation error'].join('\n')
  const hints = extractHints(report)
  assert.ok(
    hints.some(h => /真实代码问题/.test(h)),
    `should point at the code, got: ${hints.join(' | ')}`
  )
})
