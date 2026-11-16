#!/usr/bin/env node
/**
 * End-to-end smoke test for Build-Runner.
 *
 * Exercises the real path — dispatch, run discovery, polling, log retrieval,
 * exit-code capture — against a real GitHub Actions run. This is the check
 * that proves the tool actually closes the loop rather than merely dispatching.
 *
 * Usage:
 *   BUILD_RUNNER_TOKEN=... node --use-system-ca tools/smoke.mjs [owner/repo]
 */
import { runCommand, diagnose } from '../src/runner.js'
import { createClient } from '../src/github.js'

const repo = process.argv[2] ?? 'Ckarefulon/Build-Runner'
const token = process.env.BUILD_RUNNER_TOKEN
if (!token) {
  console.error('need BUILD_RUNNER_TOKEN')
  process.exit(1)
}

const client = createClient({ token })

function section(title) {
  console.log(`\n=== ${title} ===`)
}

async function main() {
  section('doctor')
  const health = await diagnose({})
  for (const check of health.checks) {
    console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name}: ${check.detail}`)
  }
  if (!health.ok) {
    console.log('\n(continuing anyway: the run test below is the real signal)')
  }

  section('run: simple echo + exit 0')
  const okRun = await runCommand(client, {
    repo,
    ref: 'main',
    command: 'echo "hello from $(uname -s)"; echo "PWD=$(pwd)"; ls -la | head -n 12',
    wait: true,
    maxWaitMs: 6 * 60 * 1000,
  })
  console.log(`exit=${okRun.exitCode} conclusion=${okRun.conclusion} run=${okRun.runUrl}`)
  console.log('--- output ---')
  console.log(okRun.output.slice(0, 1200))

  section('run: non-zero exit is reported, not swallowed')
  const failRun = await runCommand(client, {
    repo,
    ref: 'main',
    command: 'echo "about to fail"; exit 42',
    wait: true,
    maxWaitMs: 6 * 60 * 1000,
  })
  console.log(`exit=${failRun.exitCode} conclusion=${failRun.conclusion} succeeded=${failRun.succeeded}`)
  console.log('--- output ---')
  console.log(failRun.output.slice(0, 600))

  section('verdict')
  // `ls -la` collapses the workdir into a `total`/`.` line, so assert on a file
  // that only exists in the checked-out repo rather than on a literal path.
  const checks = [
    ['命令输出被取回', okRun.output.includes('hello from')],
    ['工作目录是检出的仓库', okRun.output.includes('package.json')],
    ['branch 被记录', okRun.report?.ref === 'main' || okRun.ref === 'main'],
    ['commit 被记录', typeof okRun.revision === 'string' && okRun.revision.length > 0],
    ['退出码 0 被正确捕获', okRun.exitCode === 0],
    ['非零退出码被正确捕获', failRun.exitCode === 42],
    ['失败被标记为未成功', failRun.succeeded === false],
  ]
  let allOk = true
  for (const [name, ok] of checks) {
    if (!ok) allOk = false
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  }
  console.log(allOk ? '\nALL PASS' : '\nSOME CHECKS FAILED')
  process.exit(allOk ? 0 : 1)
}

main().catch(error => {
  console.error(`smoke failed: ${error.message}`)
  process.exit(1)
})
