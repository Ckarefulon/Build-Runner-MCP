/**
 * Turn anything thrown into a readable message.
 *
 * `catch (error)` does not guarantee an `Error`. A rejected promise may carry a
 * plain object, an array, a string, or — the case that wasted a debugging round —
 * an object whose `message` is itself an object, which string-interpolates to
 * `[object Object]` and tells the caller nothing.
 */
export function describeError(error) {
  if (error === null || error === undefined) return '未知错误（null/undefined）'

  if (typeof error === 'string') return error
  if (typeof error === 'number' || typeof error === 'boolean') return String(error)

  if (error instanceof Error) {
    const parts = [error.message || error.name || 'Error']
    // Node attaches the actionable detail (ECONNREFUSED, ENOENT, ...) on `cause`.
    if (error.cause) parts.push(`原因：${describeError(error.cause)}`)
    if (error.code && !String(error.message).includes(String(error.code))) {
      parts.push(`代码：${error.code}`)
    }
    // A GitHubError carries the HTTP outcome; without it the message is a guess.
    if (error.status) parts.push(`HTTP ${error.status}`)
    return parts.join('｜')
  }

  if (Array.isArray(error)) {
    return error.map(describeError).join('；') || '空数组错误'
  }

  if (typeof error === 'object') {
    // `message` may be an object (GitHub sometimes returns a body-ish object).
    if ('message' in error) {
      const inner = describeError(error.message)
      if (inner && inner !== '[object Object]') {
        const extra = error.status ? `（HTTP ${error.status}）` : ''
        return `${inner}${extra}`
      }
    }
    try {
      const json = JSON.stringify(error)
      // `JSON.stringify({})` is '{}', and many error-like objects carry nothing
      // enumerable — neither is useful, so fall back to naming the shape.
      if (json && json !== '{}') return json.slice(0, 500)
    } catch {
      /* circular; fall through */
    }
    const keys = Object.keys(error)
    return keys.length > 0
      ? `对象（字段：${keys.join(', ')}）`
      : `空对象（无可用信息，类型：${error.constructor?.name ?? 'Object'}）`
  }

  return String(error)
}

/** Throw a new Error whose message is guaranteed readable. */
export function toError(error, prefix) {
  const message = describeError(error)
  const wrapped = new Error(prefix ? `${prefix}：${message}` : message)
  wrapped.cause = error
  return wrapped
}
