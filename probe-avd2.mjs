import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// The system image never actually installed: `yes | sdkmanager` dies of SIGPIPE
// and sdkmanager silently reports success. Install it properly, verify the path
// exists, then create the AVD and boot.
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
export ANDROID_SDK_ROOT=/usr/local/lib/android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator
sudo -n chmod 666 /dev/kvm

echo "=== 已装 package 里的 system-image ==="
sdkmanager --list_installed 2>/dev/null | grep -i "system-image" | head -5 || echo "(none)"

echo "=== 接受 license ==="
sdkmanager --licenses > /tmp/lic.log 2>&1 < /dev/null || true
tail -3 /tmp/lic.log

echo "=== 安装 system image（正确姿势：printf 多个 y，不要用 yes）==="
T=$(date +%s)
( printf 'y\\n%.0s' $(seq 1 50) ) | sdkmanager --install "system-images;android-34;google_apis;x86_64" > /tmp/sys.log 2>&1
echo "install exit=$? elapsed=$(( $(date +%s) - T ))s"
tail -5 /tmp/sys.log

echo "=== 验证镜像路径 ==="
ls -d "$ANDROID_HOME/system-images/android-34/google_apis/x86_64" 2>&1
du -sh "$ANDROID_HOME/system-images" 2>/dev/null

echo "=== 创建 AVD ==="
mkdir -p "$HOME/.android/avd"
echo no | avdmanager create avd -n p5 -k "system-images;android-34;google_apis;x86_64" -d pixel_7 --force > /tmp/avd2.log 2>&1
echo "avd exit=$?"
tail -4 /tmp/avd2.log
emulator -list-avds 2>&1

echo "=== 启动计时 ==="
if emulator -list-avds 2>/dev/null | grep -q p5; then
  T=$(date +%s)
  nohup emulator -avd p5 -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot > /tmp/emu3.log 2>&1 &
  for i in $(seq 1 60); do adb devices 2>/dev/null | grep -q emulator && break; sleep 2; done
  echo "device-appear=$(( $(date +%s) - T ))s"
  for i in $(seq 1 90); do
    b=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')
    [ "$b" = "1" ] && break
    sleep 2
  done
  echo "boot-completed=$(( $(date +%s) - T ))s"
  adb devices
  adb exec-out screencap -p > /tmp/shot.png 2>/dev/null
  echo "--- 截图 ---"; ls -l /tmp/shot.png; head -c 4 /tmp/shot.png | od -An -tx1
  adb shell wm size 2>&1
else
  echo "AVD 未创建"; tail -15 /tmp/avd2.log
fi
`

const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  command: script,
  wait: true,
  maxWaitMs: 55 * 60 * 1000,
  timeoutMinutes: 50,
})

console.log(result.output.slice(-2500))