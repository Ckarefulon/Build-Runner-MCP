import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// avdmanager reports success but `emulator -list-avds` is empty. Find out where
// the AVD actually landed, then pin ANDROID_AVD_HOME so both tools agree.
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
export ANDROID_SDK_ROOT=/usr/local/lib/android/sdk
export ANDROID_AVD_HOME=$HOME/.android/avd
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator
sudo -n chmod 666 /dev/kvm

mkdir -p "$ANDROID_AVD_HOME"
echo "HOME=$HOME"
echo "ANDROID_AVD_HOME=$ANDROID_AVD_HOME"

echo "=== 创建 AVD（显式 ANDROID_AVD_HOME）==="
echo no | avdmanager create avd -n p6 -k "system-images;android-34;google_apis;x86_64" -d pixel_7 --force 2>&1 | tail -3
echo "exit=$?"

echo "=== 找 p6 落在哪 ==="
find "$HOME" /usr/local/lib/android -maxdepth 6 -name "p6*" 2>/dev/null | head
echo "--- ANDROID_AVD_HOME 内容 ---"
ls -la "$ANDROID_AVD_HOME" 2>&1 | head

echo "=== list-avds ==="
emulator -list-avds 2>&1

echo "=== 直接启动 ==="
T=$(date +%s)
nohup emulator -avd p6 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot > /tmp/e4.log 2>&1 &
for i in $(seq 1 45); do adb devices 2>/dev/null | grep -q emulator && break; sleep 2; done
echo "device-appear=$(( $(date +%s) - T ))s"
adb devices 2>&1
for i in $(seq 1 90); do
  b=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')
  [ "$b" = "1" ] && break
  sleep 2
done
echo "boot=$(( $(date +%s) - T ))s"
adb exec-out screencap -p > /tmp/s.png 2>/dev/null
echo "--- shot ---"; ls -l /tmp/s.png 2>&1; head -c 4 /tmp/s.png 2>/dev/null | od -An -tx1
echo "--- 日志前 12 行 ---"; head -12 /tmp/e4.log
`

const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  command: script,
  wait: true,
  maxWaitMs: 55 * 60 * 1000,
  timeoutMinutes: 50,
})

console.log(result.output.slice(-2200))