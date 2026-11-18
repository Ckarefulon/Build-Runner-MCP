import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Small, fast, unambiguous: proves the multi-command plumbing works before
// spending 8 minutes on a compile.
const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  commands: [
    'echo FIRST-COMMAND',
    'echo SECOND-COMMAND',
    '# this line is a comment and must be skipped',
    'echo THIRD-COMMAND',
  ],
  wait: true,
  maxWaitMs: 10 * 60 * 1000,
})

console.log('succeeded:', result.succeeded)
console.log('exitCode :', result.exitCode)
console.log('runUrl   :', result.runUrl)
console.log('--- output ---')
console.log(result.output)
