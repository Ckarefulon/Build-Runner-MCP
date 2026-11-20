/**
 * Session client: drive a resident Build-Runner job.
 *
 * The problem this solves: an agent must SEE a command's output before choosing
 * the next one, so batching commands up front does not work. Measured on an
 * Android project: the first compile in a job costs ~290s, the next ones ~2s.
 * Reusing that environment across tool calls is worth far more than shaving
 * setup time.
 *
 * Transport: GitHub Issues. A session is one issue; each command is a comment,
 * and the runner replies with a comment of its own. Issues are used instead of
 * committing files because:
 *   - comments are append-only, so no lost-update races between caller and runner
 *   - nothing is written to the repository's git history
 *   - the API can long-poll cheaply (one GET returns all new comments)
 *
 * Limits, stated honestly:
 *   - a job lives at most 6 hours, so a session is capped by that
 *   - the workspace dies with the job
 */
import { randomUUID } from 'node:crypto'
import { createClient } from './github.js'

const SESSION_WORKFLOW = 'session.yml'

export const SESSION_MARKER = '<!-- build-runner-session -->'
const CMD_PREFIX = 'BR-CMD:'
const RESULT_PREFIX = 'BR-RESULT:'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Create (or reuse) the issue that backs a session. */
export async function openSessionIssue(client, { engine, title, body }) {
  const existing = await client.request(
    'GET',
    `/repos/${engine.owner}/${engine.repo}/issues?state=open&labels=build-runner-session&per_page=20`
  )
  const hit = Array.isArray(existing)
    ? existing.find(issue => issue.title === title)
    : null
  if (hit) return { number: hit.number, url: hit.html_url, reused: true }

  const issue = await client.request('POST', `/repos/${engine.owner}/${engine.repo}/issues`, {
    body: { title, body, labels: ['build-runner-session'] },
  })
  return { number: issue.number, url: issue.html_url, reused: false }
}

/** Post one command as a comment on the session issue. */
export async function sendCommand(client, { engine, issueNumber, command, id, artifactPaths }) {
  const commandId = id ?? randomUUID().slice(0, 8)
  // The richer JSON form lets one command carry extra instructions without
  // changing the comment protocol. Raw text stays supported.
  const payload =
    artifactPaths && artifactPaths !== ''
      ? JSON.stringify({ command, artifactPaths })
      : command
  await client.request(
    'POST',
    `/repos/${engine.owner}/${engine.repo}/issues/${issueNumber}/comments`,
    { body: { body: `${CMD_PREFIX}${commandId}\n\`\`\`\n${payload}\n\`\`\`` } }
  )
  return commandId
}

/** Read every result comment; the newest value per id wins. */
export async function readResults(client, { engine, issueNumber, since }) {
  const comments = await client.request(
    'GET',
    `/repos/${engine.owner}/${engine.repo}/issues/${issueNumber}/comments?per_page=100`
  )
  const results = new Map()
  for (const comment of Array.isArray(comments) ? comments : []) {
    if (typeof comment.body !== 'string' || !comment.body.includes(RESULT_PREFIX)) continue
    const firstLine = comment.body.split('\n', 1)[0] ?? ''
    const id = firstLine.slice(firstLine.indexOf(RESULT_PREFIX) + RESULT_PREFIX.length).trim()
    if (id === '') continue
    // The payload is the JSON block after the marker line.
    const match = comment.body.match(/```json\s*([\s\S]*?)```/)
    if (!match) continue
    try {
      const parsed = JSON.parse(match[1])
      if (since && new Date(comment.created_at) < since) continue
      results.set(id, { ...parsed, id, commentId: comment.id, createdAt: comment.created_at })
    } catch {
      /* ignore malformed */
    }
  }
  return results
}

/** Wait for the result of one specific command id. */
export async function waitForResult(
  client,
  { engine, issueNumber, commandId, timeoutMs = 30 * 60 * 1000 }
) {
  const deadline = Date.now() + timeoutMs
  let delay = 1500
  while (Date.now() < deadline) {
    const results = await readResults(client, { engine, issueNumber })
    const hit = results.get(commandId)
    if (hit) return hit
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.3), 6000)
  }
  return null
}

/** Dispatch the resident job. */
export async function startSession(client, options) {
  const {
    repo,
    ref,
    shell = 'bash',
    setup = '',
    runner = 'ubuntu-latest',
    timeoutMinutes = 120,
    idleSeconds = 900,
    fetchDepth = 0,
    emulator,
    cjkFonts = false,
    workspacePatch = '',
    patchRef = '',
  } = options

  // The engine needs a ref for the dispatch; `parseSlug` does not provide one.
  const engine = {
    ...options.engine,
    ref: options.engine?.ref ?? process.env.BUILD_RUNNER_REF ?? 'main',
  }

  const session = `s-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`

  // Pin the commit this session builds from.
  //
  // The reported pain: an internal refactor forced a re-package and a second
  // emulator verification, because nobody could say which commit the first APK
  // came from. Recording the resolved SHA up front — and surfacing it in every
  // result — makes "the package and the acceptance run are the same code"
  // checkable instead of assumed.
  let pinnedCommit = null
  try {
    const resolved = await client.resolveCommit(
      String(repo).split('/')[0],
      String(repo).split('/')[1] ?? '',
      ref && ref !== 'HEAD' ? ref : undefined
    )
    pinnedCommit = resolved?.sha ?? null
  } catch {
    // A non-fatal best effort: the workflow resolves the ref itself anyway.
  }

  const issue = await openSessionIssue(client, {
    engine,
    title: `build-runner session ${session}`,
    body: [
      SESSION_MARKER,
      `# Build-Runner 常驻会话`,
      '',
      `- session: \`${session}\``,
      `- 目标仓库: \`${repo}\` @ \`${ref ?? '(默认分支)'}\``,
      pinnedCommit ? `- 基准 commit: \`${pinnedCommit}\`` : '',
      `- 上限: ${timeoutMinutes} 分钟（GitHub 单个 job 最多 6 小时）`,
      '',
      '命令以注释形式追加，每条命令由 runner 回一条结果注释。',
      '会话结束后 workspace 销毁，无法恢复。',
    ]
      .filter(Boolean)
      .join('\n'),
  })

  await client.dispatch(engine.owner, engine.repo, SESSION_WORKFLOW, {
    ref: engine.ref,
    inputs: {
      session,
      repo,
      ref: ref ?? '',
      shell,
      setup,
      runner,
      timeout_minutes: String(timeoutMinutes),
      fetch_depth: String(fetchDepth),
      // The workflow parses this JSON to install the right system image and boot
      // an emulator. Empty string means "no emulator".
      emulator: emulator ? JSON.stringify(emulator) : '',
      // Offscreen rendering needs CJK faces or every Chinese glyph is a box.
      cjk_fonts: cjkFonts ? 'true' : 'false',
      workspace_patch: workspacePatch,
      patch_ref: patchRef,
      issue: String(issue.number),
    },
  })

  return { session, issueNumber: issue.number, issueUrl: issue.url, reusedIssue: issue.reused, commit: pinnedCommit }
}

/** Run one command in the session and return its result. */
export async function runInSession(client, options) {
  const { session, issueNumber, engine, command, timeoutMs, artifactPaths } = options
  // Each command needs its OWN id. Reusing the session id made the second read
  // return the first command's result, because ids are what correlate a command
  // with its reply.
  const commandId = `${session}-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  await sendCommand(client, { engine, issueNumber, command, id: commandId, artifactPaths })
  const result = await waitForResult(client, { engine, issueNumber, commandId, timeoutMs })
  if (!result) {
    return {
      timedOut: true,
      commandId,
      note: `超时未收到结果。会话可能已结束（job 上限 6 小时）。issue #${issueNumber}`,
    }
  }
  return { commandId, ...result }
}

/**
 * Take a screenshot of the emulator and return the PNG itself.
 *
 * The runner detects the sentinel, captures the screen and inlines the PNG as
 * base64 in its reply. That keeps this to one round trip and avoids needing a
 * branch or artifact to carry a few tens of KB.
 */
/**
 * Screenshot by RENDERING, not by booting a device.
 *
 * For composable UI this is far cheaper than an emulator: it reuses the warm
 * Gradle daemon, needs no system image, and works on any runner. A real project
 * often already has a render task (this one has `:desktop:renderScreens`, which
 * draws the shared screens with ImageComposeScene).
 *
 * The trade-off is honest: it shows how a screen LAYS OUT, not how the app
 * behaves at runtime. Crashes on startup, real data loading and animations are
 * still emulator-only.
 */
export async function renderScreensInSession(client, options) {
  const {
    session,
    issueNumber,
    engine,
    gradleTask = ':desktop:renderScreens',
    outputDir,
    timeoutMs = 20 * 60 * 1000,
  } = options

  // The task writes wherever it likes (this project writes into its own build
  // dir), so collect PNGs by modification time rather than guessing a path. The
  // list is printed too: the caller needs to know which file is which screen.
  const command = [
    'chmod +x ./gradlew 2>/dev/null || true',
    'echo "=== 运行渲染任务 ==="',
    'T=$(date +%s)',
    `./gradlew ${gradleTask} --console=plain 2>&1 | tail -25`,
    'rc=$?',
    'echo "render=$(( $(date +%s) - T ))s exit=$rc"',
    'echo "=== 产出 ==="',
    // Anything newer than the task start is an output of this run.
    'find . -name "*.png" -newermt "-15 minutes" -not -path "*/node_modules/*" 2>/dev/null | head -40',
  ].join('\n')

  const result = await runInSession(client, {
    ...options,
    command,
    // AUTO_PNG tells the runner to collect whatever PNGs this command just
    // produced, so the caller does not need to know the project's output layout.
    artifactPaths: 'AUTO_PNG',
    timeoutMs,
  })
  return result
}

/**
 * Build a repeatable UI acceptance script.
 *
 * The reported cost was not the business change but re-deriving the same manual
 * sequence every time: launch, dismiss the agreement page, open the test screen,
 * tap the picker, walk DocumentsUI, single-select, multi-select, cancel, then
 * screenshot and read logcat. Written once as a script, the sequence costs the
 * same every run and the assertions are explicit rather than eyeballed.
 *
 * Deliberately built on `adb shell` + `uiautomator dump` instead of a UI
 * automation framework: no new dependency, no instrumentation APK, and the
 * output (a PNG plus a text dump) is exactly what a human would check.
 *
 * @param {object} spec
 * @param {string} spec.launch        `am start` component or intent, e.g. `-n pkg/.Main`
 * @param {Array<{name:string,text?:string,resourceId?:string,tap?:boolean}>} spec.steps
 * @param {string[]} spec.expectText  Strings that MUST appear in the final dump
 * @param {string} [spec.packageName] Package for logcat filtering
 */
export function buildUiAcceptanceScript(spec) {
  const { launch, steps = [], expectText = [], packageName } = spec
  const lines = [
    'set +e',
    'set +o pipefail',
    'export PATH="$PATH:${ANDROID_HOME:-/usr/local/lib/android/sdk}/platform-tools"',
    '',
    // Screenshots go under a build directory so the artifact collector
    // (`AUTO_PNG`, which only looks in */build/*) picks them up. Writing them to
    // /tmp silently produced zero images.
    'SHOT_DIR="build/ui-acceptance"',
    'mkdir -p "$SHOT_DIR"',
    'shot() { adb exec-out screencap -p > "$SHOT_DIR/$1.png" 2>/dev/null; echo "  截图 $SHOT_DIR/$1.png ($(stat -c%s "$SHOT_DIR/$1.png" 2>/dev/null || echo 0) 字节)"; }',
    'dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb shell cat /sdcard/ui.xml 2>/dev/null; }',
    '',
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

  // Each step is either an assertion (text must be present) or a tap.
  steps.forEach((step, index) => {
    const n = index + 1
    lines.push(`echo "===== 步骤 ${n}：${step.name} ====="`)
    if (step.expectText) {
      lines.push(
        `if dump | grep -qF ${JSON.stringify(step.expectText)}; then`,
        `  echo "  OK 找到「${step.expectText}」"`,
        'else',
        `  echo "  FAIL 没有找到「${step.expectText}」"`,
        '  FAILED=1',
        'fi'
      )
    }
    if (step.tapText) {
      // Tap by visible text: resolve the node's bounds from the dump, then tap
      // its centre. Text is what a human sees, so the script stays readable.
      lines.push(
        `bounds=$(dump | tr '>' '\\n' | grep -F ${JSON.stringify(step.tapText)} | grep -oE 'bounds="\\[[0-9]+,[0-9]+\\]\\[[0-9]+,[0-9]+\\]"' | head -1)`,
        'if [ -n "$bounds" ]; then',
        '  x1=$(echo "$bounds" | grep -oE '[0-9]+' | sed -n 1p)',
        '  y1=$(echo "$bounds" | grep -oE '[0-9]+' | sed -n 2p)',
        '  x2=$(echo "$bounds" | grep -oE '[0-9]+' | sed -n 3p)',
        '  y2=$(echo "$bounds" | grep -oE '[0-9]+' | sed -n 4p)',
        '  adb shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))',
        `  echo "  已点击「${step.tapText}」"`,
        'else',
        `  echo "  FAIL 找不到可点击的「${step.tapText}」"`,
        '  FAILED=1',
        'fi',
        'sleep 2'
      )
    }
    if (step.waitMs) lines.push(`sleep ${Math.round(step.waitMs / 1000)}`)
    if (step.screenshot !== false) lines.push(`shot step${n}`)
    lines.push('')
  })

  lines.push(
    'echo "===== 最终断言 ====="',
    'final_dump=$(dump)',
    ...expectText.map(
      text =>
        `if printf '%s' "$final_dump" | grep -qF ${JSON.stringify(text)}; then echo "  OK 「${text}」"; else echo "  FAIL 缺少「${text}」"; FAILED=1; fi`
    ),
    '',
    'echo "===== 界面元素摘要 ====="',
    `printf '%s' "$final_dump" | tr '>' '\\n' | grep -oE 'text="[^"]+"' | sed 's/text="//;s/"$//' | grep -v '^$' | head -25`,
    '',
    packageName
      ? [
          'echo "===== logcat（仅崩溃）====="',
          // `uiautomator dump` writes its node tree to logcat, which drowned the
          // useful lines. Only crashes and the app's own errors are relevant.
          `adb logcat -d -v brief 2>/dev/null | grep -E 'FATAL EXCEPTION|AndroidRuntime.*(FATAL|Process:)|ANR in' | head -20 || true`,
          'echo "----- app 自身错误 -----"',
          `adb logcat -d -v brief 2>/dev/null | grep -F "${packageName}" | grep -E ' E | W ' | tail -10 || true`,
        ].join('\n')
      : '',
    '',
    'echo "===== 结果 ====="',
    'if [ "${FAILED:-0}" = "0" ]; then echo "UI-ACCEPTANCE=PASS"; else echo "UI-ACCEPTANCE=FAIL"; fi',
  )

  return lines.filter(line => line !== '' || true).join('\n')
}

/** Capture the emulator's screen. Requires `emulator` in session_start. */
export async function screenshotInSession(client, options) {
  const { session, issueNumber, engine, timeoutMs = 60_000 } = options
  const commandId = `${session}-shot-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  await sendCommand(client, {
    engine,
    issueNumber,
    command: 'BR-SCREENSHOT',
    id: commandId,
  })
  const result = await waitForResult(client, { engine, issueNumber, commandId, timeoutMs })
  if (!result) {
    return {
      ok: false,
      note: `截图超时。确认会话里启用了 emulator，且会话仍在运行。issue #${issueNumber}`,
    }
  }
  if (!result.image?.path) {
    return { ok: false, output: result.output ?? '(无截图)', note: 'runner 没有返回图片路径' }
  }
  // The PNG is too large for a comment, so it was committed to the engine repo.
  // Fetch it as BYTES: going through a text-decoding path mangles binary data
  // (the first attempt returned a 2.4 MB "PNG" that was actually corrupted by
  // UTF-8 round-tripping).
  try {
    const ref = process.env.BUILD_RUNNER_REF ?? 'main'
    const url = `https://api.github.com/repos/${engine.owner}/${engine.repo}/contents/${result.image.path}?ref=${encodeURIComponent(ref)}`
    const token = process.env.BUILD_RUNNER_TOKEN
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw',
        'User-Agent': 'build-runner-mcp',
      },
    })
    if (!response.ok) {
      return { ok: false, note: `下载截图失败：HTTP ${response.status}` }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length < 100 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
      return { ok: false, note: `下载到的不是 PNG（${buffer.length} 字节）` }
    }
    return {
      ok: true,
      mimeType: 'image/png',
      data: buffer.toString('base64'),
      bytes: buffer.length,
      output: result.output ?? '',
    }
  } catch (error) {
    return { ok: false, note: `下载截图失败：${error.message}` }
  }
}
