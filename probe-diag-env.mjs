import { diagnoseEnvironment } from './src/diagnose.js'
import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

const result = await diagnoseEnvironment(runCommand, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  client,
})

console.log('succeeded:', result.succeeded)
console.log('runUrl   :', result.runUrl)
console.log('\n=== 判断 ===')
for (const hint of result.hints) console.log(' •', hint)
console.log('\n=== 报告 ===')
console.log(result.report.slice(0, 2600))
