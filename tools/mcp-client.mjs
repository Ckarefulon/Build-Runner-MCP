#!/usr/bin/env node
/**
 * Drive the MCP server exactly as DSH does: spawn the process, speak JSON-RPC
 * over stdio, and print the tool result the agent would see.
 *
 * Usage: BUILD_RUNNER_TOKEN=... node --use-system-ca tools/mcp-client.mjs <tool> '<json args>'
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const entry = join(__dirname, '..', 'src', 'server.js')

const tool = process.argv[2] ?? 'doctor'
// Accept `@file.json` as well as inline JSON: shells mangle quotes inside a
// JSON argument, and this harness is meant to be driven from them.
let args = {}
if (process.argv[3]) {
  const raw = process.argv[3]
  args = raw.startsWith('@')
    ? JSON.parse(readFileSync(raw.slice(1), 'utf8'))
    : JSON.parse(raw)
}

const child = spawn(process.execPath, ['--use-system-ca', entry], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: process.env,
})

let buffer = ''
const waiting = new Map()

child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8')
  let index
  while ((index = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line === '') continue
    let message
    try {
      message = JSON.parse(line)
    } catch {
      continue
    }
    const resolve = waiting.get(message.id)
    if (resolve) {
      waiting.delete(message.id)
      resolve(message)
    }
  }
})

child.stderr.on('data', chunk => {
  process.stderr.write(`[server] ${chunk}`)
})

function call(id, method, params) {
  return new Promise(resolve => {
    waiting.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

async function main() {
  const init = await call(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'mcp-client-harness', version: '1.0.0' },
  })
  console.log(`server: ${init.result.serverInfo.name} v${init.result.serverInfo.version}\n`)

  if (tool === 'list') {
    const list = await call(2, 'tools/list', {})
    for (const item of list.result.tools) {
      console.log(`- ${item.name}: ${item.description.split('\n')[0]}`)
    }
  } else {
    const started = Date.now()
    const result = await call(2, 'tools/call', { name: tool, arguments: args })
    const elapsed = ((Date.now() - started) / 1000).toFixed(1)
    if (result.error) {
      console.log(`ERROR: ${result.error.message}`)
    } else {
      console.log(result.result.content[0].text)
      console.log(`\n[耗时 ${elapsed}s, isError=${result.result.isError}]`)
    }
  }

  child.stdin.end()
  child.kill()
}

main().catch(error => {
  console.error(error)
  child.kill()
  process.exit(1)
})
