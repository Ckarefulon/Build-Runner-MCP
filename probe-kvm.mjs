import { runCommand } from './src/runner.js'
import { createClient } from './src/github.js'

const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })

// Decisive test: does this GitHub-hosted ubuntu runner have usable KVM, and can
// an emulator actually boot? Without KVM an x86_64 emulator is unusably slow
// (software rendering boots in ~10+ minutes if at all).
const probe = [
  'echo "=== KVM ==="',
  'ls -l /dev/kvm 2>&1',
  'if [ -e /dev/kvm ]; then echo "KVM 存在"; else echo "KVM 缺失"; fi',
  'grep -c "vmx\\|svm" /proc/cpuinfo 2>/dev/null || echo "no vmx/svm flag"',
  'echo "=== 预装 SDK ==="',
  'echo "ANDROID_HOME=${ANDROID_HOME:-unset}"',
  'ls "$ANDROID_HOME" 2>/dev/null | head -8',
  'echo "=== emulator 可用? ==="',
  'which emulator adb avdmanager sdkmanager 2>&1',
  'ls "$ANDROID_HOME/emulator/emulator" 2>/dev/null && echo "emulator 已装" || echo "emulator 未装"',
  'echo "=== 已装系统镜像 ==="',
  'ls "$ANDROID_HOME/system-images" 2>/dev/null || echo "无 system-images"',
].join('\n')

const result = await runCommand(client, {
  repo: 'Ckarefulon/Build-Runner',
  ref: 'main',
  command: probe,
  wait: true,
  maxWaitMs: 10 * 60 * 1000,
})
console.log(result.output)
