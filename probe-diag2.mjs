import { diagnoseEnvironment } from './src/diagnose.js'
import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'
import { writeFileSync } from 'node:fs'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

const result = await diagnoseEnvironment(runCommand, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  client,
})

writeFileSync('diag-report.txt', result.report, 'utf8')
console.log('succeeded:', result.succeeded)
console.log('\n=== 判断 ===')
for (const hint of result.hints) console.log(' •', hint)

// Show only the sections that matter for attribution.
for (const section of ['2. 缓存状态', '3. 仓库可达性', '6. Gradle 配置阶段']) {
  const idx = result.report.indexOf(`===== ${section}`)
  if (idx === -1) continue
  const next = result.report.indexOf('=====', idx + 10)
  console.log(`\n=== ${section} ===`)
  console.log(result.report.slice(idx + section.length + 10, next === -1 ? undefined : next).trim())
}
