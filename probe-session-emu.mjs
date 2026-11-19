import { startSession, runInSession, screenshotInSession } from './src/session.js'
import { createClient, parseSlug } from './src/github.js'
import { writeFileSync } from 'node:fs'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
const engine = { ...parseSlug('Ckarefulon/Build-Runner'), ref: 'main' }

const session = await startSession(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  engine,
  timeoutMinutes: 25,
  idleSeconds: 600,
  emulator: { api: 34, arch: 'x86_64', profile: 'pixel_7' },
})
console.log('session:', session.session, '| issue:', session.issueUrl)

// Emulator bring-up measured ~80s, plus job boot and checkout.
console.log('等待模拟器启动（约 150s）...')
await new Promise(r => setTimeout(r, 150000))

const check = await runInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  command: [
    'export PATH=$PATH:/usr/local/lib/android/sdk/platform-tools',
    'adb devices',
    'echo "--- boot ---"',
    'adb shell getprop sys.boot_completed',
    'echo "--- sdk ---"',
    'adb shell getprop ro.build.version.sdk',
    'echo "--- size ---"',
    'adb shell wm size',
  ].join('\n'),
  timeoutMs: 3 * 60 * 1000,
})
console.log('\n=== 设备状态 ===')
console.log('exit:', check.exitCode)
console.log(String(check.output ?? '').slice(0, 700))

const shot = await screenshotInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  timeoutMs: 2 * 60 * 1000,
})
console.log('\n=== 截图 ===')
console.log('ok:', shot.ok, '| bytes:', shot.bytes)
if (shot.ok) {
  writeFileSync('emulator-shot.png', Buffer.from(shot.data, 'base64'))
  console.log('已保存 emulator-shot.png')
} else {
  console.log(shot.note ?? shot.output)
}
