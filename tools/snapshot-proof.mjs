/**
 * End-to-end proof of workspace (uncommitted-changes) mode.
 *
 * It EDITS files in the working tree, so it refuses to run unless that is
 * explicitly accepted. Changes are restored afterwards even on failure.
 *
 * Usage:
 *   SNAPSHOT_E2E_ALLOW_DIRTY=1 BUILD_RUNNER_TOKEN=... \
 *     node tools/snapshot-proof.mjs [owner/repo] [baseRef] [dir]
 */
import { publishWorkspace, inspectBuildBranch } from '../src/snapshot.js'
import { runCommand } from '../src/runner.js'
import { createClient } from '../src/github.js'
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.SNAPSHOT_E2E_ALLOW_DIRTY !== '1') {
  console.error(
    '这个脚本会修改当前工作区（结束后会还原）。\n' +
      '确认要跑请设置：SNAPSHOT_E2E_ALLOW_DIRTY=1'
  )
  process.exit(1)
}
if (!process.env.BUILD_RUNNER_TOKEN) {
  console.error('need BUILD_RUNNER_TOKEN')
  process.exit(1)
}

const MARKER = `SNAPSHOT-PROOF-${Date.now().toString(36)}`
const repo = process.argv[2] ?? process.env.BUILD_RUNNER_REPO ?? 'Ckarefulon/Build-Runner'
const baseRef = process.argv[3] ?? 'main'
const dir = process.argv[4] ?? process.cwd()
const targetFile = 'PROOF.txt'
const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

if (!existsSync(join(dir, '.gitignore'))) {
  console.error(`${dir} 下没有 .gitignore，无法做「修改已跟踪文件」的验证`)
  process.exit(1)
}

console.log(`marker: ${MARKER}`)
console.log(`target: ${repo}@${baseRef}`)
console.log(`dir   : ${dir}\n`)

// Edit a tracked file (.gitignore exists) and add an untracked one. Neither is
// committed -- that is the entire premise being tested.
const backup = readFileSync(join(dir, '.gitignore'), 'utf8')
writeFileSync(join(dir, '.gitignore'), `${backup}# ${MARKER}\n`)
writeFileSync(join(dir, targetFile), `${MARKER}\n`)

let ok = false
try {
  const status = readFileSync(join(dir, '.gitignore'), 'utf8').includes(MARKER)
  console.log(`local .gitignore edited (not committed): ${status}`)

  console.log('\n=== publish snapshot ===')
  const published = await publishWorkspace(client, {
    dir,
    repo,
    baseRef,
    branch: 'build-runner',
  })
  console.log(
    `changed=${published.changed} uploaded=${(published.uploadedBytes / 1024).toFixed(1)}KiB ` +
      `sha=${published.sha.slice(0, 7)} branch=${published.branch}`
  )
  console.log(`summary=${JSON.stringify(published.summary)}`)

  const branch = await inspectBuildBranch(client, { repo, branch: 'build-runner' })
  console.log(`build branch -> ${branch.sha.slice(0, 7)} "${branch.message}"`)

  console.log('\n=== build via snapshot mode (workspaceDir), the real path an AI uses ===')
  const result = await runCommand(client, {
    repo,
    ref: baseRef,
    workspaceDir: dir,
    workspaceBranch: 'build-runner',
    command: [
      'echo "--- does the UNCOMMITTED edit exist in the cloud? ---"',
      `if grep -q '${MARKER}' .gitignore; then echo "EDIT-VISIBLE"; else echo "EDIT-MISSING"; fi`,
      `if [ -f ${targetFile} ]; then echo "NEWFILE-VISIBLE"; else echo "NEWFILE-MISSING"; fi`,
      'echo "--- parent linkage (proves real history, not a tarball) ---"',
      'git rev-parse HEAD',
      'git rev-parse HEAD~1',
      'echo "--- log ---"',
      'git log --oneline -3',
    ].join('\n'),
    wait: true,
    maxWaitMs: 8 * 60 * 1000,
  })

  console.log(`exit=${result.exitCode} conclusion=${result.conclusion}\n`)
  console.log(result.output)

  const parentMatch = result.output.match(/^([0-9a-f]{40})$/gm) ?? []
  const parentLine = (result.output.split('--- parent linkage (proves real history, not a tarball) ---')[1] ?? '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^[0-9a-f]{40}$/.test(line))
  const headSha = parentLine[0]
  const parentSha = parentLine[1]
  const [owner, name] = repo.split('/')
  const baseMainSha = (await client.resolveCommit(owner, name, baseRef)).sha

  const checks = [
    ['未提交的修改出现在云端', result.output.includes('EDIT-VISIBLE')],
    ['未跟踪的新文件出现在云端', result.output.includes('NEWFILE-VISIBLE')],
    ['云端看不到旧内容', !result.output.includes('EDIT-MISSING')],
    ['构建成功', result.exitCode === 0],
    // The decisive one: the snapshot commit's parent is the real main commit,
    // so version numbers derived from history behave exactly as they would
    // after a genuine push.
    [
      `快照的父提交就是真实基线（${parentSha?.slice(0, 7)} == ${baseMainSha.slice(0, 7)}）`,
      Boolean(parentSha) && parentSha === baseMainSha,
    ],
  ]
  console.log('\n=== verdict ===')
  ok = true
  for (const [name, passed] of checks) {
    if (!passed) ok = false
    console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}`)
  }
} finally {
  writeFileSync(join(dir, '.gitignore'), backup)
  if (existsSync(join(dir, targetFile))) rmSync(join(dir, targetFile))
  console.log('\nworking tree restored')
}

console.log(ok ? '\nSNAPSHOT PROOF PASS' : '\nSNAPSHOT PROOF FAIL')
process.exit(ok ? 0 : 1)
