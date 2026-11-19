import { startSession, renderScreensInSession } from './src/session.js'
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

const result = await renderScreensInSession(client, {
  session: session.session,
  issueNumber: session.issueNumber,
  engine,
  gradleTask: ':desktop:renderScreens',
})
console.log('exit:', result.exitCode)
console.log('--- output ---')
console.log(String(result.output ?? '').slice(-1600))
console.log('--- artifacts ---')
console.log(JSON.stringify(result.artifacts ?? [], null, 2))
