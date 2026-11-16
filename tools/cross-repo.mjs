#!/usr/bin/env node
/**
 * Cross-repository verification: the whole point of Build-Runner is running
 * commands in a repository that has NO workflow of its own. This proves the
 * engine really belongs to the runner repo, not to the target.
 *
 * Usage: BUILD_RUNNER_TOKEN=... node --use-system-ca tools/cross-repo.mjs owner/repo branch
 */
import { runCommand } from '../src/runner.js'
import { createClient } from '../src/github.js'

const repo = process.argv[2] ?? 'Ckarefulon/dsh-providers-hub'
const ref = process.argv[3] ?? 'master'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

async function main() {
  console.log(`target: ${repo}@${ref}\n`)

  console.log('=== 1. branch validation must reject a wrong branch instantly ===')
  const started = Date.now()
  try {
    await runCommand(client, {
      repo,
      ref: 'this-branch-does-not-exist',
      command: 'echo should-not-run',
      wait: false,
    })
    console.log('FAIL: 错误分支没有被拦住')
  } catch (error) {
    console.log(`PASS  ${Date.now() - started}ms  ${error.message}`)
  }

  console.log('\n=== 2. real command in a repository with no workflow of its own ===')
  const result = await runCommand(client, {
    repo,
    ref,
    command: [
      'echo "repo root: $(pwd)"',
      'echo "--- files ---"',
      'ls -1 | head -n 15',
      'echo "--- package.json name ---"',
      'node -e "console.log(require(\'./package.json\').name, require(\'./package.json\').version)"',
    ].join('\n'),
    wait: true,
    maxWaitMs: 8 * 60 * 1000,
  })

  console.log(`exit=${result.exitCode} conclusion=${result.conclusion}`)
  console.log(`revision=${result.revision} ref=${result.ref}`)
  console.log('--- output ---')
  console.log(result.output)

  console.log('\n=== 3. a failing build command reports real diagnostics ===')
  const failed = await runCommand(client, {
    repo,
    ref,
    command: 'node -e "process.exit(3)"',
    wait: true,
    maxWaitMs: 8 * 60 * 1000,
  })
  console.log(`exit=${failed.exitCode} succeeded=${failed.succeeded}`)

  const ok =
    result.exitCode === 0 &&
    result.output.length > 50 &&
    result.revision !== null &&
    failed.exitCode === 3 &&
    failed.succeeded === false
  console.log(ok ? '\nCROSS-REPO PASS' : '\nCROSS-REPO FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch(error => {
  console.error(`cross-repo failed: ${error.message}`)
  process.exit(1)
})
