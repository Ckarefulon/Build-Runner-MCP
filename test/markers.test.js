/**
 * Regression tests for marker parsing.
 *
 * GitHub echoes a step's script before running it. Any marker value therefore
 * appears TWICE: once as the literal expression in the echo, once as the real
 * printed result. Matching the first occurrence yields garbage like
 * `BUILD-RUNNER-SHELL=$IN_SHELL"` — which is what reached a caller's output.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJobLog } from '../src/logs.js'

const TS = '2026-11-17T15:59:33.6932825Z '
const line = text => `${TS}${text}`

const FIXTURE = [
  // --- echoed script (the trap) ---
  line('##[group]Run set -uo pipefail'),
  line('\u001b[36;1mecho "BUILD-RUNNER-EXIT-CODE=$rc"\u001b[0m'),
  line('\u001b[36;1mecho "BUILD-RUNNER-DURATION-SECONDS=$elapsed"\u001b[0m'),
  line('\u001b[36;1mecho "BUILD-RUNNER-SHELL=$IN_SHELL"\u001b[0m'),
  line('##[endgroup]'),
  // --- real execution ---
  line('--- BUILD-RUNNER-OUTPUT-BEGIN ---'),
  line('probe'),
  line('--- BUILD-RUNNER-OUTPUT-END ---'),
  line('BUILD-RUNNER-EXIT-CODE=0'),
  line('BUILD-RUNNER-DURATION-SECONDS=7'),
  line('BUILD-RUNNER-SHELL=bash'),
].join('\n')

test('shell is read from the result, not the echoed script', () => {
  const result = parseJobLog(FIXTURE)
  assert.equal(result.shell, 'bash')
  assert.doesNotMatch(result.shell, /\$IN_SHELL/)
  assert.doesNotMatch(result.shell, /\u001b/)
})

test('exit code and duration are also taken from the last occurrence', () => {
  const result = parseJobLog(FIXTURE)
  assert.equal(result.exitCode, 0)
  assert.equal(result.durationSeconds, 7)
})

test('a non-zero exit code still wins over the echo', () => {
  const withFailure = FIXTURE.replace(
    'BUILD-RUNNER-EXIT-CODE=0',
    'BUILD-RUNNER-EXIT-CODE=42'
  )
  assert.equal(parseJobLog(withFailure).exitCode, 42)
})

test('ANSI codes around a marker do not leak into the value', () => {
  const ansi = [
    line('--- BUILD-RUNNER-OUTPUT-BEGIN ---'),
    line('\u001b[1;31mBUILD-RUNNER-SHELL=zsh\u001b[0m'),
    line('--- BUILD-RUNNER-OUTPUT-END ---'),
  ].join('\n')
  const result = parseJobLog(ansi)
  assert.equal(result.shell, 'zsh')
})

test('output between the sentinels is unaffected by the marker fix', () => {
  const result = parseJobLog(FIXTURE)
  assert.equal(result.output.trim(), 'probe')
})
