import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Three commands in ONE job on a real Android repo. If the daemon is reused the
// second and third compiles should be dramatically faster than the first.
const result = await runCommand(client, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  commands: [
    'chmod +x ./gradlew',
    'T=$(date +%s); ./gradlew :app:compileDebugKotlin -q 2>&1 | tail -3; echo "CMD1=$(( $(date +%s) - T ))s"',
    'T=$(date +%s); ./gradlew :app:compileDebugKotlin -q 2>&1 | tail -3; echo "CMD2=$(( $(date +%s) - T ))s"',
    'T=$(date +%s); ./gradlew :app:compileDebugKotlin -q 2>&1 | tail -3; echo "CMD3=$(( $(date +%s) - T ))s"',
  ],
  wait: true,
  maxWaitMs: 40 * 60 * 1000,
  timeoutMinutes: 35,
})

console.log('succeeded:', result.succeeded)
console.log('runUrl   :', result.runUrl)
console.log('--- output ---')
const out = result.output
for (const m of out.matchAll(/CMD\d=\d+s/g)) console.log(' ', m[0])
console.log('')
console.log(out.slice(-800))
