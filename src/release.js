/**
 * Package build outputs and publish them as a GitHub Release.
 *
 * The build, the zip and the release upload all happen inside one Actions job.
 * Bringing the outputs back to the caller's machine first would move exactly
 * the bytes this design avoids moving, and would cap package size at whatever
 * fits comfortably in memory.
 */

import { randomUUID } from 'node:crypto'
import { parseSlug } from './github.js'
import { parseJobLog, clip, summarizeFailure } from './logs.js'
import { RUNNER_REPO_FALLBACK, normalizeShell, resolveTargets, verifyRef } from './runner.js'
import { prepareWorkspace } from './snapshot.js'

export const RELEASE_WORKFLOW_FILE = 'release.yml'

const POLL_MIN_MS = 1000
const POLL_MAX_MS = 2500
const RELEASE_JOB_NAME = 'build and publish'

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function locateRun(client, engine, tag, { expectCreatedAfter, timeoutMs = 90000 } = {}) {
  const deadline = Date.now() + timeoutMs
  let delay = POLL_MIN_MS
  while (Date.now() < deadline) {
    const data = await client.listRuns(engine.owner, engine.repo, {
      workflow: RELEASE_WORKFLOW_FILE,
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
    `已派发发布任务但 ${Math.round(timeoutMs / 1000)} 秒内没找到对应运行。` +
      ' 请确认 release.yml 在构建器仓库的默认分支上，且 Actions 已启用。'
  )
}

/** Default release tag: <repo>-<shortsha>, matching the workflow's own rule. */
export function defaultReleaseTag({ repo, ref, shortSha }) {
  const slug = String(repo).replace(/\//g, '-')
  return `${slug}-${shortSha ?? ref ?? 'latest'}`.replace(/[^A-Za-z0-9._-]+/g, '-')
}

/**
 * @param {object} client
 * @param {object} options
 * @param {string} options.repo            target repository (owner/name)
 * @param {string} [options.ref]           ref of the target repository
 * @param {string} options.command         build command
 * @param {string|string[]} options.artifactPaths  paths to package
 */
export async function releaseArtifacts(client, options) {
  const {
    repo,
    ref,
    command = '',
    artifactPaths = '',
    packageName,
    releaseTag,
    releaseRepo,
    releaseTitle,
    releaseNotes = '',
    draft = false,
    commitToRepo = true,
    commitBranch = 'builds',
    shell = 'bash',
    runner = 'ubuntu-latest',
    setup = '',
    timeoutMinutes = 30,
    fetchDepth,
    runnerRepo = process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK,
    runnerRef = process.env.BUILD_RUNNER_REF ?? 'main',
    maxWaitMs = 30 * 60 * 1000,
    maxOutputChars,
    wait = true,
    // Workspace mode: package the local working tree instead of a pushed ref.
    workspaceDir,
    workspaceBranch,
  } = options

  const pathText = Array.isArray(artifactPaths) ? artifactPaths.join('\n') : String(artifactPaths ?? '')
  if (pathText.trim() === '') {
    throw new Error('artifactPaths 不能为空：必须指定要打包的文件/目录')
  }

  const normalizedShell = normalizeShell(shell)
  const { target, runner: engine } = await resolveTargets(client, {
    repo,
    ref,
    runnerRepo,
    runnerRef,
  })

  if (target.ref !== 'HEAD') {
    await verifyRef(client, { owner: target.owner, repo: target.repo, ref: target.ref })
  }

  // Publishing the workspace BEFORE dispatching is what makes `release` able to
  // ship uncommitted (or unpushed) work. Without this branch, the workflow
  // checked out the remote ref and packaged whatever happened to be pushed
  // there — so a caller who had just fixed something got a package built from
  // older code, with no indication anything was wrong.
  let workspace = null
  if (workspaceDir) {
    // Patch-based: no branch is created in the target repository. The runner
    // checks out `target.ref` and applies the diff on top.
    workspace = await prepareWorkspace(client, {
      dir: workspaceDir,
      repo: target.slug,
      baseRef: target.ref === 'HEAD' ? 'HEAD' : target.ref,
      engine,
    })
  }

  const tag = `brr-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const createdAt = Date.now()

  const inputs = {
    tag,
    repo: target.slug,
    ref: target.ref,
    command,
    artifact_paths: pathText,
    workspace_patch: workspace?.patch ? workspace.patch.toString('base64') : '',
    patch_ref: workspace?.patchRef ?? '',
    package_name: packageName ?? '',
    release_tag: releaseTag ?? '',
    release_repo: releaseRepo ?? '',
    release_title: releaseTitle ?? '',
    release_notes: releaseNotes,
    draft: draft ? 'true' : 'false',
    commit_to_repo: commitToRepo === false ? 'false' : 'true',
    commit_branch: commitBranch ?? 'builds',
    shell: normalizedShell,
    runner,
    setup,
    timeout_minutes: String(timeoutMinutes),
    // A snapshot commit sits on top of the real base, so keep enough history for
    // version numbers derived from git to stay correct.
    fetch_depth: String(fetchDepth !== undefined ? fetchDepth : workspace ? 0 : 1),
  }

  await client.dispatch(engine.owner, engine.repo, RELEASE_WORKFLOW_FILE, {
    ref: engine.ref,
    inputs,
  })

  const receipt = {
    tag,
    repo: target.slug,
    // The run checks out the caller's own ref and applies the patch on top, so
    // the effective ref IS target.ref. (A previous revision published a snapshot
    // branch and tracked it here; that variable is gone with the branch mode.)
    ref: target.ref,
    shell: normalizedShell,
    runner,
    artifactPaths: pathText,
    commitBranch: commitToRepo === false ? null : (commitBranch ?? 'builds'),
    dispatchedAt: new Date(createdAt).toISOString(),
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
            patchRef: workspace.patchRef ?? null,
            transport: workspace.transport ?? (workspace.patchInline ? 'inline' : null),
            note: workspace.note,
          },
        }
      : {}),
  }

  const run = await locateRun(client, engine, tag, { expectCreatedAfter: createdAt })
  receipt.runId = run.id
  receipt.runUrl = run.html_url

  if (!wait) {
    return { ...receipt, waited: false, status: run.status }
  }

  return await waitForRelease(client, engine, run.id, { maxWaitMs, receipt, maxOutputChars })
}

export async function waitForRelease(client, engine, runId, { maxWaitMs = 30 * 60 * 1000, receipt = {}, maxOutputChars } = {}) {
  const deadline = Date.now() + maxWaitMs
  let delay = POLL_MIN_MS
  let run = await client.getRun(engine.owner, engine.repo, runId)

  while (run.status !== 'completed') {
    if (Date.now() > deadline) {
      return {
        ...receipt,
        runId,
        runUrl: run.html_url,
        timedOut: true,
        status: run.status,
        note: `等待超时（${Math.round(maxWaitMs / 1000)} 秒），任务仍在运行。用 status 工具继续查询 runId=${runId}。`,
      }
    }
    await sleep(delay)
    delay = Math.min(Math.round(delay * 1.3), POLL_MAX_MS)
    run = await client.getRun(engine.owner, engine.repo, runId)
  }

  return await collectRelease(client, engine, run, { receipt, maxOutputChars })
}

export async function collectRelease(client, engine, run, { receipt = {}, maxOutputChars } = {}) {
  const jobsData = await client.getRunJobs(engine.owner, engine.repo, run.id)
  const jobs = Array.isArray(jobsData?.jobs) ? jobsData.jobs : []
  const job = jobs.find(item => item.name === RELEASE_JOB_NAME) ?? jobs[0] ?? null

  let parsed = { output: '', exitCode: null, report: {}, hasSection: false, durationSeconds: null }
  let logNote = null
  if (job) {
    try {
      const raw = await client.getJobLog(engine.owner, engine.repo, job.id)
      parsed = parseJobLog(raw)
      if (!parsed.hasSection) {
        parsed.output = ''
        logNote = 'no-build-output'
      }
    } catch (error) {
      logNote = `无法读取日志：${error.message}`
    }
  } else {
    logNote = '找不到 job 信息'
  }

  const clipped = clip(parsed.output, { maxChars: maxOutputChars ?? 20000, headChars: 5000 })
  const report = parsed.report ?? {}

  // A failed build fails the job before packaging, so no release exists. Report
  // the build failure itself rather than a vague "no release".
  const buildFailed = run.conclusion !== 'success' && report.build_outcome === 'failure'

  return {
    ...receipt,
    runId: run.id,
    runUrl: run.html_url,
    status: run.status,
    conclusion: run.conclusion,
    succeeded: run.conclusion === 'success',
    exitCode: parsed.exitCode,
    buildFailed,
    revision: report.sha ?? null,
    // Release facts come from the workflow's own report block, which is written
    // only after the release actually exists.
    package: report.package
      ? {
          name: report.package,
          bytes: Number(report.package_bytes ?? 0) || null,
          sha256: report.package_sha256 ?? null,
        }
      : null,
    release: report.release_url
      ? { tag: report.release_tag ?? null, url: report.release_url }
      : null,
    committed: report.committed === 'true',
    commitBranch: report.committed === 'true' ? (receipt.commitBranch ?? 'builds') : null,
    output: clipped.text,
    outputTruncated: clipped.truncated,
    failureHints: run.conclusion === 'success' ? null : summarizeFailure(parsed.output),
    ...(logNote ? { logNote } : {}),
  }
}
