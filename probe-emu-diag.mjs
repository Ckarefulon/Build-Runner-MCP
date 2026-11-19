import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Why did the emulator not appear? Check the three usual suspects:
//   1. /dev/kvm permissions (runner must be in the kvm group)
//   2. emulator's own log
//   3. whether a plain `emulator -accel-check` passes
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

echo "=== 用户与组 ==="
id
echo "--- /dev/kvm 权限 ---"
ls -l /dev/kvm

echo "=== accel-check ==="
emulator -accel-check 2>&1 | head -20

echo "=== 启动模拟器（前台 25 秒看日志）==="
yes | sdkmanager --install "emulator" > /dev/null 2>&1
yes | sdkmanager --install "system-images;android-34;google_apis;x86_64" > /dev/null 2>&1
echo no | avdmanager create avd -n probe2 -k "system-images;android-34;google_apis;x86_64" -d pixel_7 --force > /dev/null 2>&1

timeout 25 emulator -avd probe2 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot 2>&1 | head -40
echo "(exit=$?)"

echo "=== adb devices ==="
adb devices 2>&1

echo "=== AVD 配置 ==="
cat "$HOME/.android/avd/probe2.avd/config.ini" 2>/dev/null | head -20
`

const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  command: script,
  wait: true,
  maxWaitMs: 30 * 60 * 1000,
  timeoutMinutes: 25,
})

console.log(result.output.slice(-3000))