/**
 * Tests for artifact naming rules.
 *
 * Two failure modes are locked down here:
 *   1. an APK wrapped in a zip cannot be installed on a phone;
 *   2. a variant suffix after the extension (`app.apk.debug`) is not
 *      recognised by any installer — it must go before it (`app.debug.apk`).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planPackage } from '../src/naming.js'

test('single file keeps its extension and gains the suffix', () => {
  const plan = planPackage({
    name: 'toolbox-408',
    suffix: 'debug',
    matched: ['out/app-debug.apk'],
  })
  assert.equal(plan.kind, 'single')
  assert.equal(plan.file, 'toolbox-408.debug.apk')
})

test('suffix goes before the extension, never after', () => {
  const plan = planPackage({ name: 'app', suffix: 'debug', matched: ['app-release.apk'] })
  assert.ok(plan.file.endsWith('.debug.apk'), `got ${plan.file}`)
  assert.ok(!plan.file.includes('.apk.'), 'extension must come last')
})

test('a leading dot in the suffix is tolerated', () => {
  const plan = planPackage({ name: 'app', suffix: '.debug', matched: ['a.apk'] })
  assert.equal(plan.file, 'app.debug.apk')
})

test('no suffix leaves the plain name', () => {
  const plan = planPackage({ name: 'app', suffix: '', matched: ['a.apk'] })
  assert.equal(plan.file, 'app.apk')
})

test('name already carrying the suffix is not doubled', () => {
  const plan = planPackage({ name: 'app.debug', suffix: 'debug', matched: ['a.apk'] })
  assert.equal(plan.file, 'app.debug.apk')
})

test('multiple files are archived, not published loose', () => {
  const plan = planPackage({ name: 'app', suffix: 'debug', matched: ['a.apk', 'b.txt'] })
  assert.equal(plan.kind, 'archive')
  assert.equal(plan.file, 'app.debug.zip')
})

test('a directory match is archived', () => {
  const plan = planPackage({ name: 'app', suffix: '', matched: ['out/'], isDirectory: true })
  assert.equal(plan.kind, 'archive')
  assert.equal(plan.file, 'app.zip')
})

test('file without an extension gets .bin rather than a bare name', () => {
  const plan = planPackage({ name: 'tool', suffix: '', matched: ['tool'] })
  assert.equal(plan.file, 'tool.bin')
})

test('dotfiles and multi-dot names resolve to the last segment', () => {
  assert.equal(
    planPackage({ name: 'x', suffix: '', matched: ['app-1.2.3.apk'] }).file,
    'x.apk'
  )
})
