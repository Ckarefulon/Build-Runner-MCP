/**
 * Tests for turning arbitrary thrown values into readable messages.
 *
 * The failure this prevents: a tool call returned a bare `Error: [object Object]`,
 * which told the caller nothing and cost a debugging round.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { describeError, toError } from '../src/errors.js'

test('an Error keeps its message', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
})

test('a plain object with a message is unwrapped', () => {
  // The exact case that produced `[object Object]`.
  assert.equal(describeError({ message: 'bad request' }), 'bad request')
})

test('a nested object message does not degrade to [object Object]', () => {
  const result = describeError({ message: { detail: 'nested' } })
  assert.doesNotMatch(result, /\[object Object\]/)
  assert.match(result, /nested/)
})

test('a non-Error with no message is JSON-serialised', () => {
  const result = describeError({ status: 502, reason: 'gateway' })
  assert.match(result, /502/)
  assert.match(result, /gateway/)
})

test('an empty object is still identifiable', () => {
  const result = describeError({})
  assert.ok(result.length > 0)
  assert.doesNotMatch(result, /^\[object Object\]$/)
})

test('strings and primitives pass through', () => {
  assert.equal(describeError('plain string'), 'plain string')
  assert.equal(describeError(42), '42')
})

test('null and undefined are named', () => {
  assert.match(describeError(null), /null/)
  assert.match(describeError(undefined), /undefined/)
})

test('a cause chain is included, because that is where the real reason lives', () => {
  const inner = new Error('connect ECONNREFUSED')
  const outer = new Error('fetch failed')
  outer.cause = inner
  const result = describeError(outer)
  assert.match(result, /fetch failed/)
  assert.match(result, /ECONNREFUSED/)
})

test('an HTTP status carried on the error is surfaced', () => {
  const error = new Error('Not Found')
  error.status = 404
  assert.match(describeError(error), /404/)
})

test('an array of errors is joined rather than stringified', () => {
  const result = describeError([new Error('first'), new Error('second')])
  assert.match(result, /first/)
  assert.match(result, /second/)
})

test('a circular object does not throw', () => {
  const circular = { message: 'cyclic' }
  circular.self = circular
  assert.doesNotThrow(() => describeError(circular))
})

test('toError prefixes and preserves the cause', () => {
  const original = new Error('original')
  const wrapped = toError(original, '准备失败')
  assert.match(wrapped.message, /准备失败/)
  assert.match(wrapped.message, /original/)
  assert.equal(wrapped.cause, original)
})
