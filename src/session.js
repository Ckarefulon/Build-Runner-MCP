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
export async function sendCommand(client, { engine, issueNumber, command, id }) {
  const commandId = id ?? randomUUID().slice(0, 8)
  await client.request(
    'POST',
    `/repos/${engine.owner}/${engine.repo}/issues/${issueNumber}/comments`,
    { body: { body: `${CMD_PREFIX}${commandId}\n\`\`\`\n${command}\n\`\`\`` } }
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
    workspacePatch = '',
    patchRef = '',
  } = options

  // The engine needs a ref for the dispatch; `parseSlug` does not provide one.
  const engine = {
    ...options.engine,
    ref: options.engine?.ref ?? process.env.BUILD_RUNNER_REF ?? 'main',
  }

  const session = `s-${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`
  const issue = await openSessionIssue(client, {
    engine,
    title: `build-runner session ${session}`,
    body: [
      SESSION_MARKER,
      `# Build-Runner 常驻会话`,
      '',
      `- session: \`${session}\``,
      `- 目标仓库: \`${repo}\` @ \`${ref ?? '(默认分支)'}\``,
      `- 上限: ${timeoutMinutes} 分钟（GitHub 单个 job 最多 6 小时）`,
      '',
      '命令以注释形式追加，每条命令由 runner 回一条结果注释。',
      '会话结束后 workspace 销毁，无法恢复。',
    ].join('\n'),
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
      workspace_patch: workspacePatch,
      patch_ref: patchRef,
      issue: String(issue.number),
    },
  })

  return { session, issueNumber: issue.number, issueUrl: issue.url, reusedIssue: issue.reused }
}

/** Run one command in the session and return its result. */
export async function runInSession(client, options) {
  const { session, issueNumber, engine, command, timeoutMs } = options
  const commandId = await sendCommand(client, { engine, issueNumber, command, id: session })
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
