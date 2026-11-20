/**
 * UI acceptance: build a repeatable script for the emulator.
 *
 * The cost being attacked is repetition. The same manual sequence — launch, dismiss
 * the agreement page, open the test screen, tap the picker, walk DocumentsUI,
 * single-select, multi-select, cancel — was re-derived by hand every run, so no two
 * runs were comparable and nothing could be asserted.
 *
 * Built on `adb shell` + `uiautomator dump` on purpose: no UI-automation
 * dependency, no instrumentation APK, and the output (PNGs plus a text dump) is
 * exactly what a human would inspect.
 *
 * Locating elements by their VISIBLE TEXT keeps the script readable and survives
 * layout changes, which coordinates do not.
 */

/** Shell helpers shared by every acceptance script. */
const SHELL_PRELUDE = `
set +e
set +o pipefail
export PATH="$PATH:\${ANDROID_HOME:-/usr/local/lib/android/sdk}/platform-tools"

# Screenshots go under a build directory because the artifact collector only
# scans */build/* — writing to /tmp produced "PASS but zero images".
SHOT_DIR="build/ui-acceptance"
mkdir -p "$SHOT_DIR"
shot() {
  adb exec-out screencap -p > "$SHOT_DIR/$1.png" 2>/dev/null
  echo "  截图 $SHOT_DIR/$1.png ($(stat -c%s "$SHOT_DIR/$1.png" 2>/dev/null || echo 0) 字节)"
}
dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb shell cat /sdcard/ui.xml 2>/dev/null; }

FAILED=0
fail() { echo "  FAIL $1"; FAILED=1; }

# Resolve a node's centre from the current dump by matching visible text.
#
# Returns empty on failure instead of emitting junk. The previous version piped
# straight into an arithmetic expansion so a miss became a bare "syntax error
# near unexpected token" and never mentioned which text was missing.
center_of() {
  want="$1"
  node=$(dump | tr '>' '\\n' | grep -F "$want" | head -1)
  [ -z "$node" ] && return 1
  bounds=$(printf '%s' "$node" | grep -oE 'bounds="\\[[0-9]+,[0-9]+\\]\\[[0-9]+,[0-9]+\\]"' | head -1)
  [ -z "$bounds" ] && return 1
  x1=$(printf '%s' "$bounds" | grep -oE '[0-9]+' | sed -n 1p)
  y1=$(printf '%s' "$bounds" | grep -oE '[0-9]+' | sed -n 2p)
  x2=$(printf '%s' "$bounds" | grep -oE '[0-9]+' | sed -n 3p)
  y2=$(printf '%s' "$bounds" | grep -oE '[0-9]+' | sed -n 4p)
  # Every component must be numeric or the arithmetic below is a syntax error.
  for v in "$x1" "$y1" "$x2" "$y2"; do
    case "$v" in ''|*[!0-9]*) return 1 ;; esac
  done
  echo $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
}

# Is the node matching this text enabled and clickable?
is_enabled() {
  node=$(dump | tr '>' '\\n' | grep -F "$1" | head -1)
  [ -z "$node" ] && return 1
  printf '%s' "$node" | grep -q 'enabled="true"'
}

tap_text() {
  pos=$(center_of "$1")
  if [ -z "$pos" ]; then
    fail "文本「$1」不在界面上（无法点击）"
    return 1
  fi
  adb shell input tap $pos
  echo "  已点击「$1」@ $pos"
  sleep 2
  return 0
}

scroll_down() {
  adb shell input swipe 540 1800 540 700 300
  sleep 1
}

scroll_to_end_marker() {
  # Scroll until the dump stops changing, capped so a non-scrollable screen still
  # terminates.
  prev=""
  for i in $(seq 1 8); do
    cur=$(dump | md5sum)
    [ "$cur" = "$prev" ] && break
    prev="$cur"
    scroll_down
  done
}
`

/**
 * Turn one step spec into shell lines.
 *
 * Supported actions (combinable):
 *   expectText    assert the text is present (does not fail the step by itself)
 *   tapText       tap the centre of the node showing that text
 *   tapAt         tap raw coordinates [x, y] — the escape hatch
 *   inputText     type into the focused field
 *   swipe         'up' | 'down' | 'left' | 'right'
 *   scrollToEnd   scroll until the screen stops changing
 *   untilEnabled  with tapText: scroll until the node reports enabled=true
 */
function stepLines(step, index) {
  const n = index + 1
  const out = [`echo "===== 步骤 ${n}：${step.name} ====="`]

  if (step.scrollToEnd) {
    out.push('scroll_to_end_marker')
  }

  if (step.swipe) {
    const swipes = {
      up: '540 1800 540 700',
      down: '540 700 540 1800',
      left: '900 1200 200 1200',
      right: '200 1200 900 1200',
    }
    const coords = swipes[String(step.swipe).toLowerCase()] ?? swipes.up
    out.push(`adb shell input swipe ${coords} 300`, 'sleep 1')
  }

  if (step.expectText) {
    out.push(
      `if dump | grep -qF ${JSON.stringify(step.expectText)}; then`,
      `  echo "  OK 找到「${step.expectText}」"`,
      'else',
      `  fail "没有找到「${step.expectText}」"`,
      'fi'
    )
  }

  if (step.tapText) {
    const label = JSON.stringify(step.tapText)
    if (step.untilEnabled) {
      // The commonest Android pattern: a "continue"/"agree" button stays
      // disabled until the content is scrolled to the bottom.
      out.push(
        `ok=0`,
        `for i in $(seq 1 10); do`,
        `  if is_enabled ${label}; then ok=1; break; fi`,
        `  echo "  「${step.tapText}」尚不可点，滚动…"`,
        `  scroll_down`,
        `done`,
        `if [ "$ok" = "0" ]; then fail "「${step.tapText}」始终未变为可点击"; else tap_text ${label}; fi`
      )
    } else {
      out.push(`tap_text ${label}`)
    }
  }

  if (step.tapAt && Array.isArray(step.tapAt) && step.tapAt.length === 2) {
    out.push(
      `adb shell input tap ${Number(step.tapAt[0])} ${Number(step.tapAt[1])}`,
      `echo "  已点击坐标 (${Number(step.tapAt[0])}, ${Number(step.tapAt[1])})"`,
      'sleep 2'
    )
  }

  if (step.inputText !== undefined) {
    // `adb shell input text` takes one argument: spaces must become %s, and the
    // shell metacharacters that survive quoting must be backslash-escaped.
    // Encode spaces FIRST — escaping afterwards would turn the % into \% and the
    // device would receive a literal "hello\%sworld".
    const encoded = String(step.inputText)
      .replace(/ /g, '%s')
      .replace(/([%$'"()&|;<>\\`])/g, '\\$1')
      // The space placeholder must stay unescaped.
      .replace(/\\%s/g, '%s')
    out.push(`adb shell input text ${JSON.stringify(encoded)}`, 'sleep 1')
  }

  if (step.waitMs) out.push(`sleep ${Math.max(1, Math.round(step.waitMs / 1000))}`)
  if (step.screenshot !== false) out.push(`shot step${n}`)
  return out
}

/**
 * @param {object} spec
 * @param {string} spec.launch        `am start` args, e.g. `-n pkg/.Main`
 * @param {Array<object>} spec.steps  see stepLines for the action vocabulary
 * @param {string[]} spec.expectText  strings that MUST appear at the end
 * @param {string} [spec.packageName] package for logcat filtering
 */
export function buildUiAcceptanceScript(spec) {
  const { launch, steps = [], expectText = [], packageName } = spec
  const lines = [
    SHELL_PRELUDE,
    'echo "===== 启动 ====="',
    `adb shell am start -W ${launch} 2>&1 | tail -3`,
    'sleep 3',
    'shot launch',
    '',
    'echo "===== 等待界面稳定 ====="',
    'for i in $(seq 1 20); do',
    '  d=$(dump)',
    '  [ -n "$d" ] && break',
    '  sleep 1',
    'done',
    '',
  ]

  for (const [index, step] of steps.entries()) {
    lines.push(...stepLines(step, index), '')
  }

  lines.push(
    'echo "===== 最终断言 ====="',
    'final_dump=$(dump)',
    ...expectText.map(
      text =>
        `if printf '%s' "$final_dump" | grep -qF ${JSON.stringify(text)}; then echo "  OK 「${text}」"; else fail "缺少「${text}」"; fi`
    ),
    '',
    'echo "===== 界面元素摘要 ====="',
    `printf '%s' "$final_dump" | tr '>' '\\n' | grep -oE 'text="[^"]+"' | sed 's/text="//;s/"$//' | grep -v '^$' | head -25`,
    ''
  )

  if (packageName) {
    lines.push(
      'echo "===== logcat（仅崩溃）====="',
      // `uiautomator dump` writes its whole node tree to logcat, which drowned the
      // useful lines under a broad pattern.
      `adb logcat -d -v brief 2>/dev/null | grep -E 'FATAL EXCEPTION|Process: ${packageName}|ANR in' | head -20`,
      'echo "----- app 自身错误 -----"',
      `adb logcat -d -v brief 2>/dev/null | grep -F "${packageName}" | grep -E ' E | W ' | tail -10`,
      ''
    )
  }

  lines.push(
    'echo "===== 结果 ====="',
    'if [ "$FAILED" = "0" ]; then echo "UI-ACCEPTANCE=PASS"; else echo "UI-ACCEPTANCE=FAIL"; fi'
  )

  return lines.join('\n')
}
