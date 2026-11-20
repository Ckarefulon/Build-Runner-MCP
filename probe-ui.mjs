import { startSession, runInSession, buildUiAcceptanceScript } from './src/session.js'
import { createClient, parseSlug } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = { ...parseSlug('Ckarefulon/Build-Runner'), ref: 'main' }

// A real UI acceptance run needs a built APK to install first, which is the
// whole point: package and verification must be the same commit.
const session = await startSession(client, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  engine,
  timeoutMinutes: 45,
  idleSeconds: 900,
  emulator: { api: 34, arch: 'x86_64', profile: 'pixel_7' },
})
console.log('session:', session.session, '| issue:', session.issueNumber, '| commit:', session.commit)

console.log('等待模拟器就绪（约 180s）...')
await new Promise(r => setTimeout(r, 200000))

// Prove the acceptance harness itself works, using a system app so this test
// does not depend on a project build finishing first.
const script = buildUiAcceptanceScript({
  launch: '-a android.settings.SETTINGS',
  steps: [
    { name: '设置主界面已打开', expectText: 'Settings' },
    { name: '再次截图确认', expectText: 'Settings' },
  ],
  expectText: ['Settings'],
  packageName: 'com.android.settings',
  collectScreenshots: true,
})

const result = await runInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  command: script,
  artifactPaths: 'AUTO_PNG',
  timeoutMs: 8 * 60 * 1000,
})
const out = String(result.output ?? '')
console.log('verdict:', /UI-ACCEPTANCE=PASS/.test(out) ? 'PASS' : /UI-ACCEPTANCE=FAIL/.test(out) ? 'FAIL' : '??')
console.log(out.slice(-1800))
console.log('screenshots:', (result.artifacts ?? []).length)
