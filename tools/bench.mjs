import { runCommand } from '../src/runner.js'
import { createClient } from '../src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Measure the pieces separately so the number can be attributed, not guessed.
const CMD = `
chmod +x ./gradlew 2>/dev/null || true
mark() { echo "ELAPSED_$1=$(( $(date +%s) - T0 ))s"; }
T0=$(date +%s)

echo "=== gradle wrapper download ==="
./gradlew --version > /tmp/v.log 2>&1 || { cat /tmp/v.log; exit 1; }
grep -E "^Gradle|^Kotlin|^JVM" /tmp/v.log
mark version

echo "=== dependency resolution (cold) ==="
./gradlew dependencies --configuration runtimeClasspath -q > /tmp/d.log 2>&1
mark deps

echo "=== compile ==="
./gradlew build -x test --no-daemon --info 2>&1 | grep -E "BUILD SUCCESSFUL|BUILD FAILED|Task :compile|Task :jar" | head -20
mark build
`

const label = process.argv[2] ?? 'cold'
const result = await runCommand(client, {
  repo: 'Ckarefulon/br-bench',
  ref: 'main',
  command: CMD,
  wait: true,
  maxWaitMs: 15 * 60 * 1000,
  timeoutMinutes: 15,
})
console.log(`\n[${label}] conclusion=${result.conclusion} exit=${result.exitCode}`)
console.log(`runner-reported duration: ${result.durationSeconds}s`)
console.log(result.output)
