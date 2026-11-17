/**
 * Orchestration: dispatch a run, find it again, wait for it, fetch its output.
 *
 * The hard part is not running the command — GitHub Actions does that. It is
 * closing the loop back to the caller: workflow_dispatch returns 204 with no
 * run id, so the run has to be rediscovered by a caller-supplied tag, and the
 * output has to be reassembled from a job log that GitHub only serves for
 * finished jobs.
 */

import { randomUUID } from 'node:crypto'
import { createClient, GitHubError, parseSlug } from './github.js'
import { parseJobLog, clip, summarizeFailure } from './logs.js'
import { prepareWorkspace } from './snapshot.js'

export const RUNNER_REPO_FALLBACK = 'Ckarefulon/Build-Runner'
export const WORKFLOW_FILE = 'run.yml'

const POLL_MIN_MS = 1000
// Kept low on purpose: this is pure scheduling slack between the job finishing
// and the caller learning about it.
const POLL_MAX_MS = 2500

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Normalize a shell request onto what the workflow understands. */
export function normalizeShell(value) {
  const shell = String(value ?? 'bash').trim().toLowerCase()
  if (shell === '' || shell === 'bash' || shell === 'sh' || shell === 'shell') return 'bash'
  if (shell === 'pwsh' || shell === 'powershell') return 'pwsh'
  if (shell === 'python' || shell === 'python3') return 'python'
  throw new Error(`不支持的 shell：${value}（可用 bash / pwsh / python）`)
}

/**
 * Validate the whole request before spending any runner minutes.
 * A typo in `ref` should fail in 200ms here, not 40s later inside a job.
 */
export async function resolveTargets(client, { repo, ref, runnerRepo, runnerRef }) {
  const target = parseSlug(repo)
  if (!target) throw new Error(`无法解析仓库 "${repo}"，请使用 owner/name 或完整 GitHub URL`)

  const runner = parseSlug(runnerRepo ?? RUNNER_REPO_FALLBACK)
  if (!runner) throw new Error(`无法解析构建器仓库 "${runnerRepo}"`)

  const resolvedRef = String(ref ?? '').trim() || 'HEAD'
  return {
    target: { ...target, slug: `${target.owner}/${target.repo}`, ref: resolvedRef },
    runner: { ...runner, slug: `${runner.owner}/${runner.repo}`, ref: runnerRef ?? 'main' },
  }
}

/**
 * Fail fast on an unknown branch/tag/commit, with the close matches listed:
 * an AI that typed `mian` should be told `main` exists instead of getting a
 * checkout failure from inside the job.
 */
export async function verifyRef(client, { owner, repo, ref }) {
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return { kind: 'sha', ref }
  try {
    await client.getBranch(owner, repo, ref)
    return { kind: 'branch', ref }
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error
  }
  try {
    const repoInfo = await client.getRepo(owner, repo)
    if (repoInfo?.default_branch === ref) return { kind: 'branch', ref }
  } catch {
    // fall through to the error below
  }
  const suggestions = []
  try {
    const repoInfo = await client.getRepo(owner, repo)
    if (repoInfo?.default_branch) suggestions.push(repoInfo.default_branch)
  } catch {
    // ignore
  }
  const hint = suggestions.length > 0 ? `（该仓库默认分支是 ${suggestions.join('、')}）` : ''
  throw new Error(`仓库 ${owner}/${repo} 上找不到分支/标签 "${ref}"${hint}`)
}

/** Find the run for a tag, retrying until GitHub has indexed the dispatch. */
async function locateRun(client, runner, tag, { expectCreatedAfter, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let delay = POLL_MIN_MS
  while (Date.now() < deadline) {
    const data = await client.listRuns(runner.owner, runner.repo, {
      workflow: WORKFLOW_FILE,
      perPage: 30,
    })
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : []
    const hit = runs.find(run => {
      if (typeof run.display_title !== 'string' || !run.display_title.includes(tag)) return false
      if (expectCreatedAfter) {
        const created = Date.parse(run.created_at ?? '')
        if (Number.isFinite(created) && created + 5000 < expectCreatedAfter) return false
      }
      return true
    })
    if (hit) return hit
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.4), POLL_MAX_MS)
  }
  throw new Error(
    `已派发但 ${Math.round(timeoutMs / 1000)} 秒内没找到对应的运行。` +
      ' 常见原因：构建器仓库的 Actions 被禁用，或 workflow 文件不在默认分支上。'
  )
}

/**
 * Dispatch a command and optionally wait for it.
 *
 * @returns {Promise<object>} dispatch receipt, or the full result when `wait`.
 */
export async function runCommand(client, options) {
  const {
    repo,
    ref,
    command,
    shell = 'bash',
    runner = 'ubuntu-latest',
    setup = '',
    timeoutMinutes = 30,
    artifactPaths = '',
    // Leave undefined on purpose: "not specified" has to stay distinguishable
    // from "explicitly 1", because snapshot mode needs full history unless the
    // caller says otherwise.
    fetchDepth,
    cache = 'auto',
    wait = false,
    runnerRepo = process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK,
    runnerRef = process.env.BUILD_RUNNER_REF ?? 'main',
    maxWaitMs = 30 * 60 * 1000,
    maxOutputChars,
    verifyBranch = true,
    // Workspace mode: build the local working tree instead of a pushed ref.
    workspaceDir,
    workspaceMode = 'head',
    workspaceBranch,
  } = options

  if (typeof command !== 'string' || command.trim() === '') {
    throw new Error('command 不能为空')
  }
  const normalizedShell = normalizeShell(shell)
  const context = client ?? createClient({ token: process.env.BUILD_RUNNER_TOKEN })
  const { target, runner: engine } = await resolveTargets(context, {
    repo,
    ref,
    runnerRepo,
    runnerRef,
  })

  let workspace = null

  // Snapshot mode: send a PATCH of the local changes instead of publishing a
  // branch. The target repository is never written to — the runner checks out
  // the caller's own branch and applies the diff.
  if (verifyBranch && target.ref !== 'HEAD') {
    await verifyRef(context, { owner: target.owner, repo: target.repo, ref: target.ref })
  }
  if (workspaceDir) {
    workspace = await prepareWorkspace(context, {
      dir: workspaceDir,
      repo: target.slug,
      baseRef: target.ref === 'HEAD' ? 'HEAD' : target.ref,
      // Patches too large for a dispatch input are parked on a disposable branch
      // in the ENGINE repo — never the target.
      engine,
    })
  }

  // Always check out the caller's own ref. The patch is applied on top, so
  // history stays real (`git describe`, `rev-list --count`) and no synthetic
  // commit is needed.
  const checkoutRef = target.ref

  const tag = `br-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const createdAt = Date.now()
  const inputs = {
    tag,
    repo: target.slug,
    ref: checkoutRef,
    command,
    shell: normalizedShell,
    runner,
    timeout_minutes: String(timeoutMinutes),
    setup,
    // A workspace build needs REAL history: `git describe`, `git rev-list
    // --count` and version codes derived from commit counts all read it, and a
    // shallow clone silently answers "1".
    fetch_depth: String(
      fetchDepth !== undefined ? fetchDepth : workspace ? 0 : 1
    ),
    workspace_patch: workspace?.patch ? workspace.patch.toString('base64') : '',
    patch_ref: workspace?.patchRef ?? '',
    cache,
    artifact_paths: Array.isArray(artifactPaths) ? artifactPaths.join('\n') : String(artifactPaths ?? ''),
  }

  await context.dispatch(engine.owner, engine.repo, WORKFLOW_FILE, {
    ref: engine.ref,
    inputs,
  })

  const receipt = {
    tag,
    repo: target.slug,
    ref: checkoutRef,
    shell: normalizedShell,
    runner,
    command,
    dispatchedAt: new Date(createdAt).toISOString(),
    workflow: `https://github.com/${engine.slug}/actions/workflows/${WORKFLOW_FILE}`,
    ...(workspace
      ? {
          workspace: {
            mode: 'patch',
            changed: workspace.changed,
            summary: workspace.summary,
            baseSha: workspace.baseSha,
            localHead: workspace.localHead ?? null,
            aheadOfRemote: workspace.aheadOfRemote === true,
            patchBytes: workspace.patchBytes ?? 0,
            note: workspace.note,
          },
        }
      : {}),
  }

  const run = await locateRun(context, engine, tag, { expectCreatedAfter: createdAt })
  receipt.runId = run.id
  receipt.runUrl = run.html_url
  receipt.status = run.status
  receipt.conclusion = run.conclusion ?? null

  if (!wait) {
    return { ...receipt, waited: false }
  }

  const result = await waitForRun(context, engine, run.id, {
    maxWaitMs,
    tag,
    receipt,
    maxOutputChars,
  })
  return { ...receipt, ...result }
}

/** Poll a run to completion, then collect its output. */
export async function waitForRun(client, engine, runId, options = {}) {
  const { maxWaitMs = 30 * 60 * 1000, tag, receipt = {}, maxOutputChars } = options
  const context = client
  const deadline = Date.now() + maxWaitMs

  // Polling cadence is a real cost, not a detail: a growing interval means the
  // caller waits up to POLL_MAX_MS after the job already finished. Measured on
  // a ~50s run, scheduling slack accounted for ~40s of wall clock. Keep the
  // interval short and constant-ish; the runs API is cheap and well within
  // rate limits for the ~40 calls a 2-minute build needs.
  let delay = POLL_MIN_MS
  let run = await context.getRun(engine.owner, engine.repo, runId)

  while (run.status !== 'completed') {
    if (Date.now() > deadline) {
      return {
        ...receipt,
        runId,
        runUrl: run.html_url,
        waited: true,
        timedOut: true,
        status: run.status,
        conclusion: null,
        exitCode: null,
        output: '',
        note: `等待超时（${Math.round(maxWaitMs / 1000)} 秒）但任务仍在运行。可用 status 工具继续查询 runId=${runId}。`,
      }
    }
    await sleep(delay)
    // Ramp gently and cap low: after a few seconds the run is either moments
    // from done or minutes away, and a 2s poll costs far less than being slow.
    delay = Math.min(Math.round(delay * 1.15), 2500)
    run = await context.getRun(engine.owner, engine.repo, runId)
  }

  return await collectResult(context, engine, run, { tag, maxOutputChars, receipt })
}

/** Read the finished run's log and turn it into the caller-facing result. */
export async function collectResult(client, engine, run, options = {}) {
  const { maxOutputChars, receipt = {} } = options
  const context = client
  const jobsData = await context.getRunJobs(engine.owner, engine.repo, run.id)
  const jobs = Array.isArray(jobsData?.jobs) ? jobsData.jobs : []
  const job = jobs.find(item => item.name === 'run command') ?? jobs[0] ?? null

  let parsed = {
    output: '',
    exitCode: null,
    durationSeconds: null,
    shell: null,
    report: {},
    hasSection: false,
  }
  let logNote = null

  if (job) {
    try {
      const raw = await context.getJobLog(engine.owner, engine.repo, job.id)
      parsed = parseJobLog(raw)
      if (!parsed.hasSection) {
        // The job died before the command wrapper printed anything: keep the
        // tail so the caller sees the real infrastructure failure.
        const rawText = raw.toString('utf8')
        parsed.output =
          '（命令未执行到输出阶段，下面是 job 日志末尾，通常说明是检出/环境准备失败）\n\n' +
          rawText.split('\n').slice(-120).join('\n')
        logNote = 'no-command-section'
      }
    } catch (error) {
      logNote = `无法读取日志：${error.message}`
    }
  } else {
    logNote = '找不到 job 信息'
  }

  const clipped = clip(parsed.output, {
    maxChars: maxOutputChars ?? 24000,
    headChars: 6000,
  })

  const succeeded = run.conclusion === 'success'
  // A cancelled/timed-out job never reports an exit code; surface that instead
  // of pretending the command returned 0.
  const exitCode =
    parsed.exitCode ?? (succeeded ? 0 : run.conclusion === 'cancelled' ? 130 : null)

  let artifacts = []
  try {
    const list = await context.listArtifacts(engine.owner, engine.repo, run.id)
    artifacts = (list?.artifacts ?? []).map(item => ({
      name: item.name,
      sizeBytes: item.size_in_bytes,
      expired: item.expired,
      downloadUrl: item.archive_download_url,
    }))
  } catch {
    artifacts = []
  }

  return {
    ...receipt,
    runId: run.id,
    runUrl: run.html_url,
    waited: true,
    status: run.status,
    conclusion: run.conclusion,
    succeeded,
    exitCode,
    durationSeconds: parsed.durationSeconds,
    shell: parsed.shell ?? receipt.shell,
    revision: parsed.report.sha ?? null,
    commit: parsed.report.commit ?? null,
    output: clipped.text,
    outputTruncated: clipped.truncated,
    outputBytes: parsed.bytes ?? 0,
    outputLines: parsed.lines ?? 0,
    failureHints: succeeded ? null : summarizeFailure(parsed.output),
    artifacts,
    // Outranks a plain head build: the caller must know the run used a snapshot
    // of uncommitted local changes, not a pushed commit.
    mode: receipt.workspace ? 'snapshot' : 'head',
    ...(logNote ? { logNote } : {}),
  }
}

/** Status of an existing run, with the same result shape as a finished one. */
export async function getRunStatus(client, { runId, runnerRepo, maxOutputChars }) {
  const engine = parseSlug(runnerRepo ?? process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK)
  const context = client ?? createClient({ token: process.env.BUILD_RUNNER_TOKEN })
  const run = await context.getRun(engine.owner, engine.repo, runId)
  if (run.status === 'completed') {
    return await collectResult(context, engine, run, { maxOutputChars })
  }
  return {
    runId: run.id,
    runUrl: run.html_url,
    status: run.status,
    conclusion: run.conclusion ?? null,
    waited: false,
    note: '任务仍在运行，稍后再查。',
  }
}

/** Cancel an in-flight run (the only way to stop billing minutes). */
export async function cancelRun(client, { runId, runnerRepo }) {
  const engine = parseSlug(runnerRepo ?? process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK)
  const context = client ?? createClient({ token: process.env.BUILD_RUNNER_TOKEN })
  await context.cancelRun(engine.owner, engine.repo, runId)
  return { runId, cancelled: true, runUrl: `https://github.com/${engine.slug}/actions/runs/${runId}` }
}

/**
 * Check the runner is wired up correctly: token, repo access, workflow
 * presence, and whether Actions can actually run. This is the first thing to
 * call when a dispatch mysteriously produces no run.
 */
export async function diagnose({ runnerRepo, runnerRef = 'main' } = {}) {
  const engine = parseSlug(runnerRepo ?? process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK)
  const report = { runnerRepo: engine ? `${engine.owner}/${engine.repo}` : null, checks: [] }
  const push = (name, ok, detail) => report.checks.push({ name, ok, detail })

  let client
  try {
    client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
    push('token', true, '已设置 BUILD_RUNNER_TOKEN')
  } catch (error) {
    push('token', false, error.message)
    report.ok = false
    return report
  }

  try {
    const user = await client.getUser()
    push('identity', true, `登录为 ${user.login}`)
  } catch (error) {
    push('identity', false, error.message)
  }

  let repoInfo = null
  try {
    repoInfo = await client.getRepo(engine.owner, engine.repo)
    push('repository', true, `可访问 ${engine.owner}/${engine.repo}（默认分支 ${repoInfo.default_branch}）`)
  } catch (error) {
    push('repository', false, error.message)
    report.ok = false
    return report
  }

  // `size` in the repo payload is an asynchronously refreshed object count, so
  // it reads 0 for a while after the first push. Ask for the actual HEAD
  // commit instead of trusting it.
  try {
    const head = await client.request('GET', `/repos/${engine.owner}/${engine.repo}/commits/${runnerRef}`)
    push('has-commit', true, `HEAD = ${String(head.sha).slice(0, 7)} ${head.commit?.message?.split('\n')[0] ?? ''}`)
  } catch (error) {
    push('has-commit', false, `拿不到 ${runnerRef} 上的提交：${error.message}`)
  }

  try {
    const wf = await client.getWorkflow(engine.owner, engine.repo, WORKFLOW_FILE)
    push('workflow', true, `找到 ${WORKFLOW_FILE}（state=${wf.state}）`)
    if (wf.state !== 'active') {
      push('workflow-active', false, `workflow 状态是 ${wf.state}，需要启用 Actions`)
    }
  } catch (error) {
    push('workflow', false, error.message)
  }

  try {
    const list = await client.listRuns(engine.owner, engine.repo, { workflow: WORKFLOW_FILE, perPage: 1 })
    const recent = list?.workflow_runs?.[0]
    push('runs-api', true, recent ? `最近一次运行：${recent.status}/${recent.conclusion ?? '-'}` : '还没有运行记录')
  } catch (error) {
    push('runs-api', false, error.message)
  }

  report.ok = report.checks.every(check => check.ok)
  return report
}
