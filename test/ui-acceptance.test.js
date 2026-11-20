/**
 * Tests for the UI acceptance script builder.
 *
 * The cost being attacked is repetition: the same manual sequence (launch, dismiss
 * the agreement page, open the test screen, tap the picker, walk DocumentsUI,
 * single-select, multi-select, cancel) was re-derived by hand every time, so
 * nothing was ever comparable between runs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildUiAcceptanceScript } from '../src/session.js'

test('the script launches the app and screenshots it', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n com.example/.Main',
    steps: [],
    expectText: [],
  })
  assert.match(script, /am start -W -n com\.example\/\.Main/)
  assert.match(script, /screencap -p/)
})

test('a text expectation becomes an assertion, not a note', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: '进入测试页', expectText: '文件选择' }],
    expectText: [],
  })
  assert.match(script, /grep -qF "文件选择"/)
  // A missing element must fail the run rather than be logged and forgotten.
  assert.match(script, /FAILED=1/)
})

test('a tap is resolved from the visible text', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: '点选择文件', tapText: '选择文件' }],
    expectText: [],
  })
  // Tapping by text keeps the script readable and resilient to layout shifts.
  assert.match(script, /grep -F "选择文件"/)
  assert.match(script, /input tap/)
})

test('final expectations gate the verdict', () => {
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

test('logcat is filtered to the app and crashes when a package is given', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n com.example/.Main',
    steps: [],
    expectText: [],
    packageName: 'com.example',
  })
  assert.match(script, /logcat -d/)
  assert.match(script, /FATAL\|AndroidRuntime\|com\.example/)
})

test('without a package name no logcat section is emitted', () => {
  const script = buildUiAcceptanceScript({ launch: '-n p/.Main', steps: [], expectText: [] })
  assert.doesNotMatch(script, /logcat -d -v brief/)
})

test('adb is reachable regardless of where the SDK lives', () => {
  const script = buildUiAcceptanceScript({ launch: '-n p/.Main', steps: [], expectText: [] })
  // The emulator step installs the SDK outside the workspace; a bare `adb`
  // failed with "command not found" before this PATH injection.
  assert.match(script, /platform-tools/)
})

test('every step screenshots so a failure is visible, not just logged', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: 'A', expectText: 'x' }, { name: 'B', expectText: 'y' }],
    expectText: [],
  })
  assert.match(script, /shot step1/)
  assert.match(script, /shot step2/)
})

test('a step can opt out of its screenshot when it would be noise', () => {
  const script = buildUiAcceptanceScript({
    launch: '-n p/.Main',
    steps: [{ name: '等待', screenshot: false }],
    expectText: [],
  })
  assert.doesNotMatch(script, /shot step1/)
})
