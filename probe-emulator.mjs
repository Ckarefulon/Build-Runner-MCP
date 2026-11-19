import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Everything in ONE script: exports must persist for the emulator test.
// (This also confirmed a design point for sessions: commands need a persistent
// shell, or `cd`/`export` are lost between calls.)
const script = `
export ANDROID_HOME=/usr/local/lib/android/sdk
export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator

T0=$(date +%s)
yes | sdkmanager --install "emulator" > /tmp/sdk1.log 2>&1
echo "1-emulator-install=$(( $(date +%s) - T0 ))s"

T1=$(date +%s)
yes | sdkmanager --install "system-images;android-34;google_apis;x86_64" > /tmp/sdk2.log 2>&1
echo "2-sysimage-install=$(( $(date +%s) - T1 ))s"

T2=$(date +%s)
echo no | avdmanager create avd -n probe -k "system-images;android-34;google_apis;x86_64" -d pixel_7 --force > /tmp/avd.log 2>&1
echo "3-avd-create=$(( $(date +%s) - T2 ))s"

T3=$(date +%s)
nohup emulator -avd probe -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect -no-snapshot -accel on > /tmp/emu.log 2>&1 &
adb start-server > /dev/null 2>&1
for i in $(seq 1 150); do
  b=$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\\r')
  if [ "$b" = "1" ]; then break; fi
  sleep 2
done
echo "4-boot=$(( $(date +%s) - T3 ))s"

T4=$(date +%s)
adb exec-out screencap -p > /tmp/shot.png 2>/dev/null
echo "5-screencap=$(( $(date +%s) - T4 ))s"

echo "--- screenshot ---"
ls -l /tmp/shot.png 2>&1
head -c 8 /tmp/shot.png 2>/dev/null | od -An -tx1
echo "--- device ---"
adb devices 2>&1
adb shell wm size 2>&1
echo "--- installed packages ---"
adb shell pm list packages 2>/dev/null | wc -l
`

const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  command: script,
  wait: true,
  maxWaitMs: 45 * 60 * 1000,
  timeoutMinutes: 40,
})

console.log('succeeded:', result.succeeded)
console.log(result.output.slice(-2000))