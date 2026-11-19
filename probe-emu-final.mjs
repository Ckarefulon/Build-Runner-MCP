import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Decisive end-to-end test, everything in ONE run (each dispatch is a fresh VM).
// The missing piece in earlier attempts was `sudo chmod 666 /dev/kvm`: the
// runner user is not in the `kvm` group, so /dev/kvm (root:kvm 660) is denied
// and the emulator falls back to software rendering, which never finishes
// booting within any sane timeout.
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
export ANDROID_SDK_ROOT=/usr/local/lib/android/sdk
export ANDROID_AVD_HOME=$HOME/.android/avd
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

sudo -n chmod 666 /dev/kvm
echo "kvm: $(ls -l /dev/kvm)"

T0=$(date +%s)
( printf 'y\\n%.0s' $(seq 1 50) ) | sdkmanager --install "emulator" "system-images;android-34;google_apis;x86_64" > /tmp/ins.log 2>&1
echo "install=$(( $(date +%s) - T0 ))s exit=$?"

ls -d "$ANDROID_HOME/emulator/emulator" 2>&1
ls -d "$ANDROID_HOME/system-images/android-34/google_apis/x86_64" 2>&1

echo "=== accel-check ==="
"$ANDROID_HOME/emulator/emulator" -accel-check 2>&1 | head -6

mkdir -p "$ANDROID_AVD_HOME"
T1=$(date +%s)
echo no | avdmanager create avd -n ci -k "system-images;android-34;google_apis;x86_64" -d pixel_7 --force > /tmp/avd.log 2>&1
echo "avd-create=$(( $(date +%s) - T1 ))s exit=$?"
ls "$ANDROID_AVD_HOME" 2>&1
"$ANDROID_HOME/emulator/emulator" -list-avds 2>&1

echo "=== boot ==="
T2=$(date +%s)
nohup "$ANDROID_HOME/emulator/emulator" -avd ci -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot > /tmp/emu.log 2>&1 &
for i in $(seq 1 60); do adb devices 2>/dev/null | grep -q emulator && break; sleep 2; done
echo "device-appear=$(( $(date +%s) - T2 ))s"
adb devices 2>&1
for i in $(seq 1 90); do
  b=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')
  [ "$b" = "1" ] && break
  sleep 2
done
echo "boot-completed=$(( $(date +%s) - T2 ))s"

echo "=== screencap ==="
T3=$(date +%s)
adb exec-out screencap -p > /tmp/shot.png 2>/dev/null
echo "screencap=$(( $(date +%s) - T3 ))s"
ls -l /tmp/shot.png
head -c 8 /tmp/shot.png | od -An -tx1
adb shell wm size 2>&1
adb shell getprop ro.build.version.sdk 2>&1

echo "=== 失败则看日志 ==="
grep -i "error\\|fail\\|kvm" /tmp/emu.log | head -8
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