/**
 * Isolate why POST /git/blobs fails in the MCP process but works standalone.
 *
 * Method: in ONE long-lived process, interleave GET and POST against the same
 * endpoint, varying only one thing at a time. A failure that reproduces on the
 * first POST means it is the request shape; one that only appears after several
 * requests means it is connection reuse.
 */
const token = process.env.BUILD_RUNNER_TOKEN
const BASE = 'https://api.github.com/repos/Ckarefulon/Build-Runner'

const patch = Buffer.alloc(37006, 0x41)

// Exactly what the user's working script sends.
async function userStyle() {
  const r = await fetch(`${BASE}/git/blobs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: patch.toString('base64'), encoding: 'base64' }),
  })
  return { status: r.status }
}

// Exactly what src/github.js sends.
async function oursStyle() {
  const r = await fetch(`${BASE}/git/blobs`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': 'build-runner-mcp',
      'X-GitHub-Api-Version': '2022-11-28',
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: patch.toString('base64'), encoding: 'base64' }),
  })
  return { status: r.status }
}

// Ours, but with each header omitted in turn to find the culprit.
async function withoutHeader(name) {
  const headers = {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'build-runner-mcp',
    'X-GitHub-Api-Version': '2022-11-28',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  }
  delete headers[name]
  const r = await fetch(`${BASE}/git/blobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ content: patch.toString('base64'), encoding: 'base64' }),
  })
  return { status: r.status }
}

const results = []

const run = async (label, fn) => {
  try {
    const { status } = await fn()
    results.push(`${String(status).padEnd(4)} ${label}`)
  } catch (error) {
    results.push(`ERR  ${label}: ${error.message.slice(0, 80)}`)
  }
}

await run('userStyle (no UA, no API-Version, no Accept)', userStyle)
await run('oursStyle (full headers)', oursStyle)
await run('ours minus User-Agent', () => withoutHeader('User-Agent'))
await run('ours minus X-GitHub-Api-Version', () => withoutHeader('X-GitHub-Api-Version'))
await run('ours minus Accept', () => withoutHeader('Accept'))
await run('userStyle again (sanity)', userStyle)

console.log(results.join('\n'))
