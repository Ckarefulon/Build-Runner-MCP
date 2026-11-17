/**
 * Reproduce the exact runtime DSH gives the MCP server.
 *
 * DSH spawns the server as a long-lived child over stdio, with a minimal env,
 * and keeps it alive across many tool calls. A short-lived script that exits
 * immediately is a different situation: undici's connection pool never has time
 * to accumulate state, and the process teardown may mask aborted requests.
 */
import { spawn } from 'node:child_process'

const env = {
  // DSH passes the profile env: token + repo, plus whatever the host inherited.
  BUILD_RUNNER_TOKEN: process.env.BUILD_RUNNER_TOKEN,
  BUILD_RUNNER_REPO: 'Ckarefulon/Build-Runner',
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
}

const child = spawn(process.execPath, ['--use-system-ca', 'src/server.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env,
})

let buffer = ''
const pending = new Map()
child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let i
  while ((i = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, i).trim()
    buffer = buffer.slice(i + 1)
    if (!line) continue
    try {
      const msg = JSON.parse(line)
      const resolve = pending.get(msg.id)
      if (resolve) {
        pending.delete(msg.id)
        resolve(msg)
      }
    } catch {
      /* ignore non-JSON */
    }
  }
})
const stderr = []
child.stderr.on('data', d => stderr.push(d.toString()))

let nextId = 1
const call = (method, params) =>
  new Promise(resolve => {
    const id = nextId++
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

await call('initialize', {
  protocolVersion: '2024-11-05',
  capabilities: {},
  clientInfo: { name: 'probe', version: '1' },
})

// Drive the real tool path repeatedly, as an agent would.
for (let i = 0; i < 3; i += 1) {
  try {
    const res = await call('tools/call', {
      name: 'doctor',
      arguments: {},
    })
    const text = res.result?.content?.[0]?.text ?? ''
    console.log(`doctor #${i + 1}:`, text.split('\n')[0])
  } catch (error) {
    console.log(`doctor #${i + 1} threw:`, error.message)
  }
}

console.log('--- server stderr ---')
console.log(stderr.join('').split('\n').filter(Boolean).slice(0, 12).join('\n'))

child.kill()
