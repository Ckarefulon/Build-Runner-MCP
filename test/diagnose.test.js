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
  assert.match(script, /^echo "groups:/m)
  assert.match(script, /build-cache-1/)
})

test('repository probes hit a real artifact, not a directory listing', () => {
  const script = buildDiagnosticScript()
  // Probing the repo root reported Google Maven and Aliyun as 404 while both
  // serve artifacts perfectly.
  assert.match(script, /maven-metadata\.xml/)
  assert.doesNotMatch(script, /dl\.google\.com\/dl\/android\/maven2\/"/)
})

test('probes time out instead of hanging', () => {
  const script = buildDiagnosticScript()
  assert.match(script, /--max-time 6/)
})

test('section headers are ASCII so they survive transport intact', () => {
  const script = buildDiagnosticScript()
  // Non-ASCII headings came back mojibake, which made the boundaries unmatchable.
  for (const marker of ['[1] CODE', '[2] CACHE', '[3] REPOS', '[4] TOOLCHAIN', '[6] OFFLINE CONFIG']) {
    assert.ok(script.includes(marker), `missing ASCII section ${marker}`)
  }
})

test('the script proves the cache offline', () => {
  // `--offline` is decisive: success means every declared dependency is on disk.
  const script = buildDiagnosticScript()
  assert.match(script, /--offline/)
  assert.match(script, /offline-config=/)
})

test('a healthy report produces positive hints', () => {
  const report = [
    'dirty  : 0 files uncommitted',
    'groups: 812',
    'REPO Maven Central           200',
    'REPO Google Maven            200',
    'BUILD SUCCESSFUL in 34s',
    'offline-config=34s',
  ].join('\n')
  const hints = extractHints(report)
  assert.ok(hints.some(h => /全部可达/.test(h)), hints.join(' | '))
  assert.ok(hints.some(h => /缓存完整/.test(h)), hints.join(' | '))
  assert.ok(hints.some(h => /离线配置成功/.test(h)), hints.join(' | '))
  assert.ok(!hints.some(h => /不可用/.test(h)), 'must not flag healthy repos')
})

test('a truncated cache is distinguished from an empty one', () => {
  const truncated = extractHints('groups: 42\noffline-config=40s')
  assert.ok(truncated.some(h => /被截断/.test(h)), truncated.join(' | '))

  const empty = extractHints('groups: 0\noffline-config=40s')
  assert.ok(empty.some(h => /缓存为空/.test(h)), empty.join(' | '))
})

test('a failing probe is named when the build really could be affected', () => {
  const report = [
    'REPO Google Maven            404',
    'REPO Maven Central           TIMEOUT',
    'groups: 500',
  ].join('\n')
  const hints = extractHints(report)
  const line = hints.find(h => /请求失败/.test(h))
  assert.ok(line, hints.join(' | '))
  assert.match(line, /Google Maven/)
  assert.match(line, /Maven Central/)
})

test('a failing probe is downplayed when the offline build succeeded', () => {
  // A spurious 404 next to a working offline build is noise. Claiming "repository
  // down" there is what sent a previous investigation the wrong way.
  const report = [
    'REPO Maven Central           404',
    'groups: 900',
    'offline-config=34s',
  ].join('\n')
  const hints = extractHints(report)
  assert.ok(!hints.some(h => /请求失败/.test(h)), hints.join(' | '))
  assert.ok(
    hints.some(h => /但离线构建成功/.test(h)),
    `should explain that the probe failure is harmless, got: ${hints.join(' | ')}`
  )
})

test('a re-checked repository counts as reachable', () => {
  const report = ['REPO Maven Central           RECHECK_OK', 'groups: 900', 'offline-config=30s'].join('\n')
  const hints = extractHints(report)
  assert.ok(!hints.some(h => /请求失败/.test(h)), hints.join(' | '))
})

test('a missing offline result is called out rather than silently ignored', () => {
  const hints = extractHints('groups: 500\nBUILD FAILED')
  assert.ok(hints.some(h => /离线配置未成功/.test(h)), hints.join(' | '))
})

test('uncommitted work is reported so the caller knows a patch is in play', () => {
  const hints = extractHints('dirty  : 7 files uncommitted\noffline-config=50s')
  assert.ok(hints.some(h => /7 个未提交文件/.test(h)), hints.join(' | '))
})

test('leftover lock files are flagged only when numerous', () => {
  assert.ok(!extractHints('stale : 3\noffline-config=30s').some(h => /残留锁/.test(h)))
  assert.ok(extractHints('stale : 99\noffline-config=30s').some(h => /残留锁/.test(h)))
})
