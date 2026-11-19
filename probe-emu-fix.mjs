import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// The two blockers found so far:
//   1. `runner` is not in the `kvm` group, so /dev/kvm (root:kvm 660) is denied.
//      GitHub runners grant passwordless sudo, so this may be fixable.
//   2. `avdmanager create avd` failed silently. Need its real error.
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

echo "=== sudo 可用? ==="
sudo -n true 2>&1 && echo "sudo 可用" || echo "sudo 不可用"

echo "=== 修 /dev/kvm 权限 ==="
sudo -n chmod 666 /dev/kvm 2>&1 && echo "chmod 完成" || echo "chmod 失败"
ls -l /dev/kvm

echo "=== accel-check（修权限后）==="
emulator -accel-check 2>&1 | head -10

echo "=== avdmanager 真实报错 ==="
yes | sdkmanager --install "system-images;android-34;google_apis;x86_64" > /dev/null 2>&1
echo no | avdmanager create avd -n p3 -k "system-images;android-34;google_apis;x86_64" -d pixel_7 --force 2>&1 | tail -15
echo "--- AVD 目录 ---"
ls -la "$HOME/.android/avd" 2>&1 | head

echo "=== 启动测试（60 秒）==="
T=$(date +%s)
nohup emulator -avd p3 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -accel on > /tmp/emu.log 2>&1 &
for i in $(seq 1 30); do
  d=$(adb devices 2>/dev/null | grep -c emulator)
  if [ "$d" != "0" ]; then break; fi
  sleep 2
done
echo "device-appear=$(( $(date +%s) - T ))s"
adb devices

for i in $(seq 1 45); do
  b=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')
  if [ "$b" = "1" ]; then break; fi
  sleep 2
done
echo "boot-completed=$(( $(date +%s) - T ))s"

echo "=== 截图 ==="
adb exec-out screencap -p > /tmp/shot.png 2>/dev/null
ls -l /tmp/shot.png
head -c 4 /tmp/shot.png | od -An -tx1

echo "=== emulator 日志（失败时有用）==="
head -30 /tmp/emu.log
`

const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  command: script,
  wait: true,
  maxWaitMs: 40 * 60 * 1000,
  timeoutMinutes: 35,
})

console.log(result.output.slice(-3000))