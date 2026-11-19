import { startSession, runInSession } from './src/session.js'
import { createClient, parseSlug } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = { ...parseSlug('Ckarefulon/Build-Runner'), ref: 'main' }

const session = await startSession(client, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  engine,
  timeoutMinutes: 45,
  idleSeconds: 900,
})
console.log('session:', session.session, '| issue:', session.issueNumber)

await new Promise(r => setTimeout(r, 45000))

const result = await runInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  command: [
    'chmod +x ./gradlew',
    'echo "=== 安装中文字体 ==="',
    'T=$(date +%s)',
    'sudo apt-get install -y fonts-noto-cjk > /tmp/font.log 2>&1 || sudo apt-get update -qq > /dev/null 2>&1 && sudo apt-get install -y fonts-noto-cjk > /tmp/font.log 2>&1',
    'echo "install=$(( $(date +%s) - T ))s"',
    'fc-cache -f > /dev/null 2>&1',
    'echo "CJK 字体数：$(fc-list :lang=zh 2>/dev/null | wc -l)"',
    'fc-list :lang=zh 2>/dev/null | head -2',
    'echo "=== 重新渲染 ==="',
    'T2=$(date +%s)',
    './gradlew :desktop:renderScreens --console=plain 2>&1 | tail -8',
    'echo "render=$(( $(date +%s) - T2 ))s"',
    'ls -la desktop/build/screenshots/*.png 2>/dev/null | head -5',
  ].join('\n'),
  artifactPaths: 'AUTO_PNG',
  timeoutMs: 35 * 60 * 1000,
})
console.log('exit:', result.exitCode)
console.log(String(result.output ?? '').slice(-1400))
console.log('artifacts:', (result.artifacts ?? []).length)
