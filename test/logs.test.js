/**
 * Regression tests for the log parser.
 *
 * The fixture reproduces the exact shape GitHub produces for a step: the
 * runner echoes the step's own script first (ANSI-colored, timestamped), then
 * runs it. Getting this wrong silently returns the script instead of the
 * command's output, which is the one failure mode that would make the whole
 * tool useless while still looking like it works.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJobLog, clip, summarizeFailure } from '../src/logs.js'

const TS = '2026-11-15T16:19:03.4102253Z '

function line(text) {
  return `${TS}${text}`
}

const FIXTURE = [
  line('##[group]Run set -uo pipefail'),
  line('\u001b[36;1mset -uo pipefail\u001b[0m'),
  line('\u001b[36;1mprintf \'%s\\n\' "$IN_COMMAND" > "/tmp/br-run.$ext"\u001b[0m'),
  line('\u001b[36;1mecho "--- BUILD-RUNNER-OUTPUT-BEGIN ---"\u001b[0m'),
  line('\u001b[36;1mecho "--- BUILD-RUNNER-OUTPUT-END ---"\u001b[0m'),
  line('##[endgroup]'),
  line('--- build-runner echo of the command ---'),
  line('echo "hello from $(uname -s)"'),
  line('--- BUILD-RUNNER-OUTPUT-BEGIN ---'),
  line('hello from Linux'),
  line('PWD=/home/runner/work/Build-Runner/Build-Runner'),
  line('total 48'),
  line('--- BUILD-RUNNER-OUTPUT-END ---'),
  line('BUILD-RUNNER-EXIT-CODE=0'),
  line('BUILD-RUNNER-DURATION-SECONDS=1'),
  line('BUILD-RUNNER-SHELL=bash'),
  line('##[group]Post Checkout target'),
  line('================ BUILD-RUNNER-REPORT-V1 ================'),
  line('repo=Ckarefulon/Build-Runner'),
  line('ref=main'),
  line('sha=b04fd2b'),
  line('command_outcome=success'),
  line('job_status=success'),
  line('========================================================'),
].join('\n')

test('captures the executed output, not the echoed script', () => {
  const result = parseJobLog(FIXTURE)
  assert.equal(result.hasSection, true)
  assert.match(result.output, /hello from Linux/)
  assert.doesNotMatch(result.output, /IN_COMMAND/)
  assert.doesNotMatch(result.output, /OUTPUT-BEGIN/)
  assert.doesNotMatch(result.output, /\u001b\[/)
})

test('reads exit code, duration and shell', () => {
  const result = parseJobLog(FIXTURE)
  assert.equal(result.exitCode, 0)
  assert.equal(result.durationSeconds, 1)
  assert.equal(result.shell, 'bash')
})

test('reads the report block', () => {
  const result = parseJobLog(FIXTURE)
  assert.equal(result.report.sha, 'b04fd2b')
  assert.equal(result.report.job_status, 'success')
})

test('ignores the echoed report script and reads the printed banner', () => {
  // GitHub echoes the Report step's script first; those `echo "repo=$..."` lines
  // must not be mistaken for the real values.
  const withEcho = [
    line('##[group]Run echo "================ BUILD-RUNNER-REPORT-V1 ================"'),
    line('\u001b[36;1mecho "repo=$TARGET_REPO"\u001b[0m'),
    line('\u001b[36;1mecho "sha=$TARGET_SHA"\u001b[0m'),
    line('##[endgroup]'),
    line('================ BUILD-RUNNER-REPORT-V1 ================'),
    line('repo=Ckarefulon/Build-Runner'),
    line('sha=abc1234'),
    line('========================================================'),
  ].join('\n')
  const result = parseJobLog(withEcho)
  assert.equal(result.report.sha, 'abc1234')
  assert.equal(result.report.repo, 'Ckarefulon/Build-Runner')
  assert.equal(result.report['$TARGET_REPO'], undefined)
})

test('a non-zero exit code survives the round trip', () => {
  const result = parseJobLog(FIXTURE.replace('EXIT-CODE=0', 'EXIT-CODE=42'))
  assert.equal(result.exitCode, 42)
})

test('a job that died before the wrapper is detected', () => {
  const noSection = [line('##[group]Run actions/checkout@v4'), line('Error: Not Found')].join('\n')
  const result = parseJobLog(noSection)
  assert.equal(result.hasSection, false)
  assert.equal(result.output, '')
  assert.equal(result.exitCode, null)
})

test('windows CRLF and a BOM do not break parsing', () => {
  const crlf = `\uFEFF${FIXTURE.replace(/\n/g, '\r\n')}`
  const result = parseJobLog(crlf)
  assert.equal(result.hasSection, true)
  assert.match(result.output, /hello from Linux/)
})

test('clip keeps the head and tail', () => {
  const long = `${'A'.repeat(30000)}\nTAIL-MARKER`
  const result = clip(long, { maxChars: 2000, headChars: 800 })
  assert.equal(result.truncated, true)
  assert.match(result.text, /^A+/)
  assert.match(result.text, /TAIL-MARKER$/)
  assert.match(result.text, /省略了/)
})

test('short output is untouched', () => {
  const result = clip('short', { maxChars: 2000 })
  assert.equal(result.truncated, false)
  assert.equal(result.text, 'short')
})

test('failure hints surface the useful lines', () => {
  const hints = summarizeFailure('ok\nERROR: cannot find symbol\nnpm ERR! missing script\n')
  assert.ok(hints.some(hint => hint.includes('ERROR')))
  assert.ok(hints.some(hint => hint.includes('npm ERR!')))
})
