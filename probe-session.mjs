import { startSession, runInSession, readResults } from './src/session.js'
import { createClient, parseSlug } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = parseSlug('Ckarefulon/Build-Runner')

const session = await startSession(client, {
  repo: 'Ckarefulon/Build-Runner-MCP',
  ref: 'main',
  engine,
  shell: 'bash',
  timeoutMinutes: 20,
  idleSeconds: 600,
})
console.log('session :', session.session)
console.log('issue   :', session.issueUrl)

// Give the job time to boot and checkout.
console.log('\n等待会话就绪（30s）...')
await new Promise(r => setTimeout(r, 30000))

const first = await runInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  command: 'echo "命令一"; pwd; ls | head -5',
  timeoutMs: 5 * 60 * 1000,
})
console.log('\n=== 第一条 ===')
console.log('exit:', first.exitCode)
console.log(String(first.output ?? '').slice(0, 500))

// THE point: a second command in the same session, no new job.
const second = await runInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  command: 'echo "命令二：环境还在"; echo "marker-$(( 40 + 2 ))"',
  timeoutMs: 2 * 60 * 1000,
})
console.log('\n=== 第二条 ===')
console.log('exit:', second.exitCode)
console.log(String(second.output ?? '').slice(0, 500))
