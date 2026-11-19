import { startSession, runInSession } from './src/session.js'
import { createClient, parseSlug } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = { ...parseSlug('Ckarefulon/Build-Runner'), ref: 'main' }

const session = await startSession(client, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  engine,
  timeoutMinutes: 40,
  idleSeconds: 900,
})
console.log('session:', session.session, '| issue:', session.issueNumber)

await new Promise(r => setTimeout(r, 45000))

// Step 1: what fonts exist, and is a CJK font among them?
const probe = await runInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  command: [
    'echo "=== 字体总数 ==="',
    'fc-list 2>/dev/null | wc -l',
    'echo "=== CJK 字体 ==="',
    'fc-list :lang=zh 2>/dev/null | head -5 || echo "(无)"',
    'echo "=== 检查 noto cjk ==="',
    'fc-list 2>/dev/null | grep -ci "noto.*cjk\\|wqy\\|droidsansfallback" || echo 0',
  ].join('\n'),
  timeoutMs: 2 * 60 * 1000,
})
console.log('\n=== 字体探测 ===')
console.log(String(probe.output ?? '').slice(0, 700))
