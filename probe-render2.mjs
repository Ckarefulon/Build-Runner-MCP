import { startSession, runInSession, renderScreensInSession } from './src/session.js'
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

// Fonts first (measured 146s), then render — both in the SAME warm session.
const fonts = await runInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  command:
    'sudo apt-get install -y fonts-noto-cjk > /tmp/f.log 2>&1; fc-cache -f >/dev/null 2>&1; echo "cjk=$(fc-list :lang=zh 2>/dev/null | wc -l)"',
  timeoutMs: 6 * 60 * 1000,
})
console.log('fonts:', String(fonts.output ?? '').trim())

const result = await renderScreensInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  gradleTask: ':desktop:renderScreens',
})
console.log('exit:', result.exitCode)
const shots = (result.artifacts ?? []).filter(a => String(a.file).includes('screenshots'))
console.log('屏幕截图:', shots.length)
for (const s of shots.slice(0, 8)) {
  console.log(' ', s.file.split('/').pop(), Math.round(s.bytes / 1024) + 'KB')
  console.log('   ', s.url)
}
