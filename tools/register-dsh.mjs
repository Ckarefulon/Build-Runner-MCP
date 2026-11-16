#!/usr/bin/env node
/**
 * Register Build-Runner as a DSH MCP server row.
 *
 * DSH composes its profile tree from `cordis.patch.yml`, and each MCP server is
 * a loader row of `@deepseek-ai/dsh-mcp-client`. Tool names then appear to the
 * agent as `mcp__<serverName>__<tool>`.
 *
 * The token is written into the row's `env` because DSH launches this process
 * itself and cannot inherit the shell's environment. Re-running with a new
 * token rewrites that line in place instead of appending a duplicate.
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT = join(__dirname, '..')
const SERVER = join(PROJECT, 'src', 'server.js').replace(/\\/g, '/')

const patchFile = join(process.env.USERPROFILE ?? process.env.HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
const token = process.env.BUILD_RUNNER_TOKEN
const runnerRepo = process.env.BUILD_RUNNER_REPO ?? 'Ckarefulon/Build-Runner'

if (!token) {
  console.error('need BUILD_RUNNER_TOKEN')
  process.exit(1)
}
if (!existsSync(patchFile)) {
  console.error(`找不到 DSH profile 补丁文件：${patchFile}`)
  process.exit(1)
}

const BEGIN = '# >>> build-runner (managed by build-runner/tools/register-dsh.mjs) >>>'
const END = '# <<< build-runner <<<'

const block = `${BEGIN}
# Runs commands on GitHub Actions so the agent can self-verify without a local
# toolchain. Source: ${PROJECT}
- insert:
    - id: build-runner
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        transport: stdio
        serverName: build-runner
        command: ${JSON.stringify(process.execPath)}
        args:
          - --use-system-ca
          - ${SERVER}
        env:
          BUILD_RUNNER_TOKEN: ${JSON.stringify(token)}
          BUILD_RUNNER_REPO: ${JSON.stringify(runnerRepo)}
        # A cold Gradle/SDK build can legitimately take 20+ minutes.
        toolCallTimeoutMs: 2400000
${END}`

const current = readFileSync(patchFile, 'utf8')
copyFileSync(patchFile, `${patchFile}.bak-buildrunner`)

const pattern = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
let next
let mode
if (pattern.test(current)) {
  // Also catches a stale token: the block is replaced wholesale.
  next = current.replace(pattern, block)
  mode = 'updated'
} else {
  next = `${current.replace(/\s*$/, '')}\n\n${block}\n`
  mode = 'appended'
}

writeFileSync(patchFile, next, 'utf8')
console.log(`${mode} build-runner MCP row`)
console.log(`  profile : ${patchFile}`)
console.log(`  server  : ${SERVER}`)
console.log(`  tools   : mcp__build-runner__{run,release,prepare_workspace,workspace_status,workspace_reset,status,cancel,doctor}`)
console.log(`  token   : ${token.slice(0, 4)}...${token.slice(-4)} (${token.length} chars)`)
