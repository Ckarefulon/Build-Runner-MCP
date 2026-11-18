import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Compare: same compile, once with a cold daemon, once with a warm one.
// A hosted runner can keep a daemon alive *within* a single job, which is the
// cheapest possible approximation of a resident environment.
const warm = [
  'chmod +x ./gradlew',
  'echo "=== 第一次（冷 daemon）==="',
  'T0=$(date +%s); ./gradlew :app:compileDebugKotlin --daemon -q 2>&1 | tail -3; echo "FIRST=$(( $(date +%s) - T0 ))s"',
  'echo "=== 第二次（daemon 已热）==="',
  'T1=$(date +%s); ./gradlew :app:compileDebugKotlin --daemon -q 2>&1 | tail -3; echo "SECOND=$(( $(date +%s) - T1 ))s"',
  'echo "=== 改动一个文件后再编 ==="',
  'echo "// touch" >> app/src/main/java/tmp_probe.kt 2>/dev/null || true',
  'T2=$(date +%s); ./gradlew :app:compileDebugKotlin --daemon -q 2>&1 | tail -3; echo "INCREMENTAL=$(( $(date +%s) - T2 ))s"',
  'rm -f app/src/main/java/tmp_probe.kt',
].join('\n')

const result = await runCommand(client, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  command: warm,
  wait: true,
  maxWaitMs: 40 * 60 * 1000,
  timeoutMinutes: 35,
})
console.log('exit:', result.exitCode)
console.log(result.output.slice(-1500))
