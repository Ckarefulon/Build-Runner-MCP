import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'
import { writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const dir = process.cwd()

// A >48KB patch forces the branch transport (not the inline input), which is
// exactly the path that was failing.
const probe = join(dir, 'BIG_PROOF.txt')
const lines = []
for (let i = 0; i < 1500; i += 1) lines.push(`line ${i} padded to exceed the inline dispatch limit`)
writeFileSync(probe, lines.join('\n') + '\n')
console.log('probe bytes:', readFileSync(probe).length)

try {
  const result = await runCommand(client, {
    repo: 'Ckarefulon/Build-Runner-MCP',
    ref: 'main',
    workspaceDir: dir,
    command: [
      'echo "--- big local file present? ---"',
      'wc -l BIG_PROOF.txt 2>&1',
      'head -1 BIG_PROOF.txt 2>&1',
    ].join('\n'),
    wait: true,
    maxWaitMs: 12 * 60 * 1000,
  })
  console.log('succeeded:', result.succeeded)
  console.log('workspace:', JSON.stringify(result.workspace))
  console.log('--- output ---')
  console.log(result.output)
} finally {
  rmSync(probe, { force: true })
}
