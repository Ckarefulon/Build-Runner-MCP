import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Measure how much of a build is spent probing unreachable repositories.
// The target project declares an internal Nexus (nexus.itgsa.com:5566) that a
// public runner can never reach, plus several Ivy repos on github/nodejs.
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
chmod +x ./gradlew

echo "=== 目标项目声明的仓库 ==="
grep -oE 'https?://[a-zA-Z0-9./:_-]+' settings.gradle.kts | sort -u | head -10

echo "=== 探测各仓库可达性（各 5 秒超时）==="
for url in https://repo1.maven.org/maven2/ https://dl.google.com/dl/android/maven2/ https://plugins.gradle.org/m2/ http://nexus.itgsa.com:5566/repository/sharedViewKit/ https://nodejs.org/dist/ https://github.com/; do
  T=$(date +%s)
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$url" 2>/dev/null || echo TIMEOUT)
  echo "  $code  $url  ($(( $(date +%s) - T ))s)"
done

echo "=== 无配置下的配置阶段耗时 ==="
T=$(date +%s)
./gradlew :app:help --console=plain 2>&1 | tail -3
echo "config=$(( $(date +%s) - T ))s"
`

const result = await runCommand(client, {
  repo: 'yeliqin666/xjtu-toolbox-android',
  ref: 'dev',
  command: script,
  wait: true,
  maxWaitMs: 30 * 60 * 1000,
  timeoutMinutes: 25,
})
console.log(result.output.slice(-2200))