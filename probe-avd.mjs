import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Focus: why does `avdmanager create avd` produce nothing?
// Capture the exit code and full stderr, pre-create ~/.android, and verify the
// device profile exists before blaming avdmanager.
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator
sudo -n chmod 666 /dev/kvm

mkdir -p "$HOME/.android/avd"
echo "=== avdmanager 版本 ==="
avdmanager --version 2>&1 | tail -2

echo "=== 可用设备 profile（找 pixel_7）==="
avdmanager list device 2>&1 | grep -i "pixel_7\\|pixel_6" | head -5

echo "=== 创建 AVD（捕获退出码）==="
echo no | avdmanager create avd -n p4 -k "system-images;android-34;google_apis;x86_64" -d pixel_7 --force > /tmp/avdout.log 2>&1
echo "avdmanager exit=$?"
echo "--- 输出 ---"
tail -6 /tmp/avdout.log

echo "=== list-avds ==="
emulator -list-avds 2>&1

echo "=== AVD 目录 ==="
ls -la "$HOME/.android/avd" 2>&1 | head

echo "=== 若成功则启动并计时 ==="
if emulator -list-avds 2>/dev/null | grep -q p4; then
  T=$(date +%s)
  nohup emulator -avd p4 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot > /tmp/emu2.log 2>&1 &
  for i in $(seq 1 60); do
    if adb devices 2>/dev/null | grep -q emulator; then break; fi
    sleep 2
  done
  echo "device-appear=$(( $(date +%s) - T ))s"
  adb devices
  for i in $(seq 1 60); do
    b=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')
    if [ "$b" = "1" ]; then break; fi
    sleep 2
  done
  echo "boot-completed=$(( $(date +%s) - T ))s"
  adb exec-out screencap -p > /tmp/shot.png 2>/dev/null
  echo "--- 截图 ---"
  ls -l /tmp/shot.png
  head -c 4 /tmp/shot.png | od -An -tx1
  adb shell wm size 2>&1
else
  echo "AVD 未创建，跳过启动"
  echo "--- emulator 日志 ---"
  tail -20 /tmp/emu2.log 2>/dev/null
fi
`

const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  command: script,
  wait: true,
  maxWaitMs: 50 * 60 * 1000,
  timeoutMinutes: 45,
})

console.log(result.output.slice(-2500))