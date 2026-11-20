/**
 * Tests for the UI acceptance script builder.
 *
 * Two reported failures drive these:
 *   1. A missing `tapText` produced `undefined` inside an arithmetic expansion,
 *      so the whole script died with "syntax error near unexpected token `)'"
 *      and never said which text was missing.
 *   2. Only `expectText`/`tapText` existed, so the common Android pattern — a
 *      button that stays disabled until the page is scrolled to the bottom —
 *      could not be driven at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync, rmSync, mkdtempSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildUiAcceptanceScript } from '../src/ui-acceptance.js'

/** Path to a bash that exists on this machine, or null. */
function findBash() {
  for (const candidate of ['C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash', 'bash']) {
    try {
      execFileSync(candidate, ['-c', 'true'], { stdio: 'ignore' })
      return candidate
    } catch {
      /* try next */
    }
  }
  return null
}

const BASH = findBash()

test('the script is syntactically valid bash', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n com.example/.Main',
    steps: [
      { name: 'scroll', scrollToEnd: true },
      { name: 'agree', tapText: '同意', untilEnabled: true },
      { name: 'type', inputText: 'user@example.com' },
      { name: 'coord', tapAt: [540, 2124] },
      { name: 'swipe', swipe: 'up' },
      { name: 'assert', expectText: '文件选择' },
    ],
    expectText: ['已取消'],
    packageName: 'com.example',
  })

  if (!BASH) return // bash unavailable; the string-shape tests below still run
  const dir = mkdtempSync(join(tmpdir(), 'br-bash-'))
  const file = join(dir, 'gen.sh')
  try {
    writeFileSync(file, script.replace(/\r\n/g, '\n'), 'utf8')
    execFileSync(BASH, ['-n', file], { stdio: 'pipe' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing tap target reports the text instead of crashing', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: 'tap', tapText: '不存在的按钮' }],
    expectText: [],
  })
  // The coordinates are resolved into a variable and checked before use.
  assert.match(script, /pos=\$\(center_of/)
  assert.match(script, /if \[ -z "\$pos" \]/)
  assert.match(script, /文本「\$1」不在界面上/)
  // No bare `undefined` can reach the arithmetic expansion.
  assert.doesNotMatch(script, /\$\(\( \(undefined/)
})

test('untilEnabled scrolls before tapping', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: 'agree', tapText: '同意', untilEnabled: true }],
    expectText: [],
  })
  assert.match(script, /is_enabled/)
  assert.match(script, /scroll_down/)
  assert.match(script, /始终未变为可点击/)
})

test('scrollToEnd stops when the screen stops changing', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: 'end', scrollToEnd: true }],
    expectText: [],
  })
  assert.match(script, /scroll_to_end_marker/)
  assert.match(script, /md5sum/)
})

test('inputText is escaped and spaces encoded', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: 'type', inputText: 'hello world' }],
    expectText: [],
  })
  // `adb shell input text` cannot take a raw space.
  assert.match(script, /hello%sworld/)
})

test('tapAt is emitted as raw coordinates', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: 'coord', tapAt: [540, 2124] }],
    expectText: [],
  })
  assert.match(script, /input tap 540 2124/)
})

test('swipe directions map to opposite coordinates', () => {
  const up = buildUiAcceptanceScript({ launch: '-n p/.M', steps: [{ name: 's', swipe: 'up' }], expectText: [] })
  const down = buildUiAcceptanceScript({ launch: '-n p/.M', steps: [{ name: 's', swipe: 'down' }], expectText: [] })
  assert.match(up, /input swipe 540 1800 540 700/)
  assert.match(down, /input swipe 540 700 540 1800/)
})

test('expectations gate the verdict', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [],
    expectText: ['DocumentsUI', '取消'],
  })
  assert.match(script, /UI-ACCEPTANCE=PASS/)
  assert.match(script, /UI-ACCEPTANCE=FAIL/)
  assert.match(script, /grep -qF "DocumentsUI"/)
  assert.match(script, /grep -qF "取消"/)
})

test('screenshots land where the artifact collector looks', () => {
  const script = buildUiAcceptanceScript({ launch: '-n p/.Main', steps: [], expectText: [] })
  assert.match(script, /SHOT_DIR="build\/ui-acceptance"/)
  assert.doesNotMatch(script, /\/tmp\/ui-\$1\.png/)
})

test('logcat is narrowed to crashes and the app', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n com.example/.Main',
    steps: [],
    expectText: [],
    packageName: 'com.example',
  })
  assert.match(script, /FATAL EXCEPTION/)
  assert.match(script, /com\.example/)
})

test('a step can skip its screenshot', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: 'quiet', screenshot: false }],
    expectText: [],
  })
  assert.doesNotMatch(script, /shot step1/)
})
