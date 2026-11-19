#!/usr/bin/env node
/**
 * Build-Runner MCP server.
 *
 * Speaks the Model Context Protocol over stdio: newline-delimited JSON-RPC 2.0
 * on stdin/stdout. Implemented without an SDK so the package has zero runtime
 * dependencies — it must start instantly and never fail because a transitive
 * dependency was missing on the host.
 *
 * stdout carries protocol traffic ONLY. All diagnostics go to stderr.
 */

import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCommand, getRunStatus, cancelRun, diagnose, RUNNER_REPO_FALLBACK } from './runner.js'
import { createClient, parseSlug } from './github.js'
import { publishWorkspace, inspectBuildBranch, resetBuildBranch, prepareWorkspace } from './snapshot.js'
import { releaseArtifacts } from './release.js'
import { startSession, runInSession, screenshotInSession, readResults } from './session.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'))

const SERVER_INFO = { name: 'build-runner', version: pkg.version }
const PROTOCOL_VERSION = '2024-11-05'

function log(...args) {
  process.stderr.write(`[build-runner] ${args.join(' ')}\n`)
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'run',
    description:
      '在云端 GitHub Actions 上执行一条命令，并把 stdout/stderr 和真实退出码原样返回。' +
      '用于本机没有构建环境（无 JDK/Android SDK/Xcode/特定运行时）时做自检：' +
      '它检出指定仓库的指定分支，在那里跑你的命令，效果等同于本地有环境。' +
      '默认等待执行完成并返回结果。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: {
          type: 'string',
          description: '目标仓库，owner/name 或完整 GitHub URL。AI 工作区所在仓库。',
        },
        ref: {
          type: 'string',
          description: '分支、标签或完整 commit SHA。不填用仓库默认分支。',
        },
        command: {
          type: 'string',
          description:
            '要执行的命令，可多行。例如 "pnpm install && pnpm build" 或 "gradle assembleDebug"。' +
            '需要跑多条独立命令时优先用 commands —— 那样它们共享同一个热构建环境。',
        },
        commands: {
          type: 'array',
          items: { type: 'string' },
          description:
            '要顺序执行的命令列表，全部在**同一个 job** 内完成。' +
            '这比多次调用 run 快得多：Gradle 的守护进程和增量状态会被复用。' +
            '实测本项目冷编译约 231 秒，同一 job 内第二次编译仅约 1 秒。' +
            '每条命令的输出单独标注，前面失败会继续跑后面的（便于一次看到所有问题），' +
            '最终只要有失败就整体判失败。空行和以 # 开头的行会被忽略。',
        },
        shell: {
          type: 'string',
          enum: ['bash', 'pwsh', 'python'],
          description: '解释器，默认 bash。Windows 目标用 pwsh，脚本用 python。',
        },
        runner: {
          type: 'string',
          description:
            'runner 标签，默认 ubuntu-latest。可选 windows-latest、macos-latest、macos-14 等。',
        },
        setup: {
          type: 'string',
          description: '主命令前执行的准备命令（装依赖等），失败即终止。',
        },
        timeoutMinutes: {
          type: 'number',
          description: '单条命令的硬超时（分钟），默认 30，上限 120。',
        },
        artifactPaths: {
          type: 'string',
          description: '需要作为产物上传的路径，逗号或换行分隔。构建产物、测试报告放这里。',
        },
        fetchDepth: {
          type: 'number',
          description: 'git 抓取深度，默认 1（快）；需要 git 历史时设 0。',
        },
        cache: {
          type: 'string',
          enum: ['auto', 'none'],
          description: '依赖缓存，默认 auto（自动识别 pnpm/npm/gradle/cargo 等）。',
        },
        wait: {
          type: 'boolean',
          description: '是否等待执行完成，默认 true。长构建可设 false 先拿 runId 再轮询。',
        },
        maxWaitMs: {
          type: 'number',
          description: '最长等待毫秒数，默认 30 分钟。超时不取消任务。',
        },
        maxOutputChars: {
          type: 'number',
          description: '返回输出截断长度，默认 24000 字符。',
        },
        workspaceDir: {
          type: 'string',
          description:
            '本地 git 工作区目录。设置后进入「快照模式」：把该目录**未提交的改动和未推送的提交**做成补丁，' +
            '云端签出你自己的分支后应用补丁再构建。目标仓库不会多出任何分支。',
        },
        release: {
          type: 'object',
          description:
            '在同一 job 内追加打包发版：命令成功后直接打包并发布 Release，**不需要再跑一次构建**。' +
            '既省掉一次完整编译，也保证发出去的包就是刚刚验证过的那个。',
          properties: {
            artifactPaths: {
              type: 'string',
              description: '要打包的路径（逗号/换行分隔）。不填则用 run 的 artifactPaths。',
            },
            packageName: { type: 'string', description: '包名（不含扩展名）' },
            releaseTag: { type: 'string', description: 'Release tag，默认同包名' },
            releaseTitle: { type: 'string', description: 'Release 标题' },
            releaseNotes: { type: 'string', description: '附加说明' },
            draft: { type: 'boolean', description: '是否发成草稿，默认 false' },
          },
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'prepare_workspace',
    description:
      '把本地工作区的未提交改动发布到目标仓库的专用构建分支（不建快照 commit 之外的东西，也不动你的分支）。' +
      '只上传改动文件：其余内容由 GitHub 用 base_tree 在服务端拼接。' +
      'dryRun=true 可先看会传哪些文件、多少字节，再决定是否真要发布。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '目标仓库 owner/name' },
        dir: { type: 'string', description: '本地 git 工作区目录' },
        baseRef: { type: 'string', description: '本地改动所基于的分支/标签/SHA，默认 main' },
        branch: { type: 'string', description: '构建分支名，默认 build-runner' },
        message: { type: 'string', description: '快照 commit 的说明' },
        dryRun: { type: 'boolean', description: '只统计不上传，默认 false' },
      },
      required: ['repo', 'dir'],
    },
  },
  {
    name: 'workspace_status',
    description: '查看目标仓库的构建分支当前指向哪个 commit（不修改任何东西）。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '目标仓库 owner/name' },
        branch: { type: 'string', description: '构建分支名，默认 build-runner' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'workspace_reset',
    description: '把构建分支重置回某个基准分支，清掉累积的历史（构建分支会被长期保留）。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '目标仓库 owner/name' },
        baseRef: { type: 'string', description: '重置到的基准分支，默认 main' },
        branch: { type: 'string', description: '构建分支名，默认 build-runner' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'release',
    description:
      '构建并**出包**：在云端跑构建命令，把产物打成压缩包，提交到目标仓库根目录的 builds 分支，' +
      '同时在构建器仓库发布 GitHub Release 并附上包。打包在云端完成，产物不需要下载回本机再上传。' +
      '返回包名、大小、SHA256 与 Release 链接。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '目标仓库 owner/name（产物来源）' },
        ref: { type: 'string', description: '目标仓库的分支/标签/SHA，默认仓库默认分支' },
        command: {
          type: 'string',
          description: '构建命令。留空表示产物已存在于仓库中，直接打包。',
        },
        artifactPaths: {
          type: 'string',
          description: '必填。要打包的文件或目录，逗号/换行分隔，支持 glob，例如 "app/build/outputs/apk/**"',
        },
        packageName: {
          type: 'string',
          description: '包名（不含扩展名），默认 <仓库名>-<短SHA>',
        },
        releaseTag: { type: 'string', description: 'Release tag，默认同包名' },
        releaseRepo: {
          type: 'string',
          description: 'Release 发到哪个仓库，默认构建器仓库。留空即发到 Build-Runner。',
        },
        releaseTitle: { type: 'string', description: 'Release 标题' },
        releaseNotes: { type: 'string', description: '附加到 Release 说明里的额外内容' },
        draft: { type: 'boolean', description: '是否发成草稿，默认 false' },
        commitToRepo: {
          type: 'boolean',
          description: '是否同时把包提交到目标仓库根目录，默认 true',
        },
        commitBranch: {
          type: 'string',
          description: '接收产物的分支，默认 builds。用独立分支避免污染你的工作分支。',
        },
        workspaceDir: {
          type: 'string',
          description:
            '本地 git 工作区目录。设置后「出包」会先发布该目录的**未提交改动和未推送提交**到快照分支，' +
            '再从那里构建打包。不设此项时，云端只会签出已推送的代码 —— 若你的修复还没 push，' +
            '包会基于旧代码构建。',
        },
        workspaceBranch: {
          type: 'string',
          description: '快照分支名，默认 build-runner（与 run 工具共用）。',
        },
        shell: { type: 'string', enum: ['bash', 'pwsh', 'python'], description: '解释器，默认 bash' },
        runner: { type: 'string', description: 'runner 标签，默认 ubuntu-latest' },
        setup: { type: 'string', description: '构建前的准备命令' },
        timeoutMinutes: { type: 'number', description: '构建超时（分钟），默认 30' },
        wait: { type: 'boolean', description: '是否等待完成，默认 true' },
        maxWaitMs: { type: 'number', description: '最长等待毫秒数，默认 30 分钟' },
      },
      required: ['repo', 'artifactPaths'],
    },
  },
  {
    name: 'session_start',
    description:
      '开启一个**常驻云端环境**，之后可以反复在同一个环境里执行命令（session_run），' +
      '环境（Gradle daemon、增量编译状态、工作区文件）在会话期间一直保留。' +
      '实测本项目：同一个环境里第一次编译约 290 秒，之后再次编译约 1-2 秒。' +
      '会话上限受 GitHub 单个 job 限制（最多 6 小时），job 结束后环境销毁。',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: '目标仓库 owner/name' },
        ref: { type: 'string', description: '分支/标签/SHA，默认仓库默认分支' },
        shell: { type: 'string', enum: ['bash', 'pwsh', 'python'], description: '解释器，默认 bash' },
        setup: { type: 'string', description: '会话开始前执行一次的安装/准备命令' },
        runner: { type: 'string', description: 'runner 标签，默认 ubuntu-latest' },
        timeoutMinutes: {
          type: 'number',
          description: '会话最长存活分钟数，默认 120。GitHub 硬上限 360（6 小时）。',
        },
        idleSeconds: {
          type: 'number',
          description: '空闲多久后自动结束会话，默认 900 秒。',
        },
        emulator: {
          type: 'object',
          description:
            '在本会话里启动一台 Android 模拟器，之后就能 adb install / am start / logcat / 截图。' +
            '实测启动约 80 秒（安装镜像 37s + 开机 39s）。不传则不启模拟器。',
          properties: {
            api: { type: 'number', description: 'Android API 级别，默认 34' },
            arch: { type: 'string', description: '架构，默认 x86_64' },
            profile: { type: 'string', description: '设备型号，默认 pixel_7' },
            image: { type: 'string', description: '镜像类型，默认 google_apis' },
          },
        },
        workspaceDir: {
          type: 'string',
          description: '本地 git 工作区。提供后会把未提交改动和未推送提交作为补丁带进会话。',
        },
      },
      required: ['repo'],
    },
  },
  {
    name: 'session_run',
    description:
      '在**已有的常驻会话**里执行一条命令，并等待结果返回。' +
      '这是「多次命令复用同一环境」的正确用法：每次可以看完输出再决定下一条。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'session_start 返回的 session id' },
        issueNumber: { type: 'number', description: 'session_start 返回的 issueNumber' },
        command: { type: 'string', description: '要执行的命令（可多行）' },
        timeoutMs: { type: 'number', description: '等待结果的毫秒数，默认 30 分钟' },
      },
      required: ['session', 'issueNumber', 'command'],
    },
  },
  {
    name: 'session_screenshot',
    description:
      '截取会话中模拟器的当前画面，**直接把 PNG 返回给你看**。' +
      '配合 session_start 的 emulator 参数使用：可以 adb install 后启动 App，再截图确认界面是否正确。' +
      '这是唯一能让 AI 自己看到「装上去以后长什么样」的手段。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'session_start 返回的 session id' },
        issueNumber: { type: 'number', description: '会话对应的 issue 号' },
        timeoutMs: { type: 'number', description: '等待截图的毫秒数，默认 60 秒' },
      },
      required: ['session', 'issueNumber'],
    },
  },
  {
    name: 'session_status',
    description: '查看常驻会话的状态：还能活多久、执行过哪些命令、最近的结果。',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'session id' },
        issueNumber: { type: 'number', description: '会话对应的 issue 号' },
        maxOutputChars: { type: 'number', description: '返回输出截断长度' },
      },
      required: ['session', 'issueNumber'],
    },
  },
  {
    name: 'status',
    description: '查询某次云端运行的当前状态；已完成则直接返回完整输出和退出码。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'number', description: 'run 的 id（run 工具或上一次 status 返回的 runId）' },
        maxOutputChars: { type: 'number', description: '返回输出截断长度' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'cancel',
    description: '取消一次正在运行的云端任务，停止继续消耗 Actions 时间。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'number', description: '要取消的 run id' } },
      required: ['runId'],
    },
  },
  {
    name: 'doctor',
    description:
      '自检 Build-Runner 是否可用：token、构建器仓库、workflow 状态、Actions 是否正常。' +
      '派发后拿不到运行时先跑这个。',
    inputSchema: { type: 'object', properties: {} },
  },
]

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function invoke(toolName, args = {}) {
  switch (toolName) {
    case 'run': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await runCommand(client, {
        repo: args.repo,
        ref: args.ref,
        command: args.command,
        commands: args.commands,
        shell: args.shell,
        runner: args.runner,
        setup: args.setup,
        timeoutMinutes: args.timeoutMinutes,
        artifactPaths: args.artifactPaths,
        fetchDepth: args.fetchDepth,
        cache: args.cache,
        wait: args.wait !== false,
        maxWaitMs: args.maxWaitMs,
        maxOutputChars: args.maxOutputChars,
        workspaceDir: args.workspaceDir,
        workspaceBranch: args.workspaceBranch,
        release: args.release,
      })
    }
    case 'session_start': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      const engineSlug = process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK
      // `parseSlug` returns owner/repo only; the dispatch still needs a ref.
      const engine = {
        ...parseSlug(engineSlug),
        ref: process.env.BUILD_RUNNER_REF ?? 'main',
      }
      const shell = args.shell ?? 'bash'
      const timeoutMinutes = Math.min(Number(args.timeoutMinutes) || 120, 360)

      // A workspaceDir travels as a patch, exactly like `run`, so a session can
      // be started on uncommitted local work.
      let patchInline = ''
      let patchRef = ''
      if (args.workspaceDir) {
        const prepared = await prepareWorkspace(client, {
          dir: args.workspaceDir,
          repo: args.repo,
          baseRef: args.ref ?? 'HEAD',
          engine,
        })
        patchInline = prepared.patch ? prepared.patch.toString('base64') : ''
        patchRef = prepared.patchRef ?? ''
      }

      return await startSession(client, {
        repo: args.repo,
        ref: args.ref,
        engine,
        shell,
        setup: args.setup ?? '',
        runner: args.runner ?? 'ubuntu-latest',
        timeoutMinutes,
        idleSeconds: args.idleSeconds,
        emulator: args.emulator,
        workspacePatch: patchInline,
        patchRef,
      })
    }
    case 'session_run': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      const engine = parseSlug(process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK)
      return await runInSession(client, {
        session: args.session,
        issueNumber: args.issueNumber,
        engine,
        command: args.command,
        timeoutMs: args.timeoutMs,
      })
    }
    case 'session_screenshot': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      const engine = {
        ...parseSlug(process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK),
        ref: process.env.BUILD_RUNNER_REF ?? 'main',
      }
      const shot = await screenshotInSession(client, {
        session: args.session,
        issueNumber: args.issueNumber,
        engine,
        timeoutMs: args.timeoutMs,
      })
      if (!shot.ok) {
        return { ok: false, note: shot.note, output: shot.output ?? '' }
      }
      // Return a REAL image content block: this is what lets the model see the
      // UI instead of guessing from a file size.
      return {
        __imageContent: [
          { type: 'text', text: shot.output || '模拟器截图' },
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
        ],
      }
    }
    case 'session_status': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      const engine = parseSlug(process.env.BUILD_RUNNER_REPO ?? RUNNER_REPO_FALLBACK)
      const results = await readResults(client, { engine, issueNumber: args.issueNumber })
      const items = [...results.values()]
      return {
        session: args.session,
        issueNumber: args.issueNumber,
        issueUrl: `https://github.com/${engine.owner}/${engine.repo}/issues/${args.issueNumber}`,
        commandCount: items.length,
        lastResults: items.slice(-5).map(item => ({
          id: item.id,
          exitCode: item.exitCode,
          durationSeconds: item.durationSeconds,
          outputPreview: String(item.output ?? '').slice(-1500),
        })),
        note: '会话上限受 GitHub 单个 job 限制（最多 6 小时）；job 结束后环境销毁。',
      }
    }
    case 'prepare_workspace': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await publishWorkspace(client, {
        dir: args.dir,
        repo: args.repo,
        baseRef: args.baseRef ?? 'main',
        branch: args.branch ?? 'build-runner',
        message: args.message,
        dryRun: args.dryRun === true,
      })
    }
    case 'workspace_status': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await inspectBuildBranch(client, { repo: args.repo, branch: args.branch ?? 'build-runner' })
    }
    case 'workspace_reset': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await resetBuildBranch(client, {
        repo: args.repo,
        baseRef: args.baseRef ?? 'main',
        branch: args.branch ?? 'build-runner',
      })
    }
    case 'release': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await releaseArtifacts(client, {
        repo: args.repo,
        ref: args.ref,
        command: args.command ?? '',
        artifactPaths: args.artifactPaths,
        packageName: args.packageName,
        releaseTag: args.releaseTag,
        releaseRepo: args.releaseRepo,
        releaseTitle: args.releaseTitle,
        releaseNotes: args.releaseNotes,
        draft: args.draft === true,
        commitToRepo: args.commitToRepo !== false,
        commitBranch: args.commitBranch,
        shell: args.shell,
        runner: args.runner,
        setup: args.setup,
        timeoutMinutes: args.timeoutMinutes,
        wait: args.wait !== false,
        maxWaitMs: args.maxWaitMs,
        workspaceDir: args.workspaceDir,
        workspaceBranch: args.workspaceBranch,
      })
    }
    case 'status': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await getRunStatus(client, {
        runId: args.runId,
        maxOutputChars: args.maxOutputChars,
      })
    }
    case 'cancel': {
      const client = createClient({ token: process.env.BUILD_RUNNER_TOKEN })
      return await cancelRun(client, { runId: args.runId })
    }
    case 'doctor':
      return await diagnose({})
    default:
      throw new Error(`未知工具：${toolName}`)
  }
}

/** Render a result as the text an AI can act on without a second lookup. */
function render(value) {
  // release result
  if (value && typeof value === 'object' && ('release' in value || 'package' in value) && 'artifactPaths' in value) {
    const lines = []
    if (value.succeeded) {
      lines.push('📦 出包成功')
    } else if (value.buildFailed) {
      lines.push(`❌ 构建失败（exit=${value.exitCode ?? 'n/a'}），未产出包`)
    } else {
      lines.push(`❌ 出包失败（${value.conclusion ?? '未完成'}）`)
    }
    lines.push(`仓库 ${value.repo ?? '?'} @ ${value.ref ?? '?'}${value.revision ? ` (${value.revision})` : ''}`)

    // Snapshot provenance. A release built from an older remote commit while the
    // author's fix sat unpushed is exactly the failure this block prevents: the
    // package looked fine, but contained none of the fix.
    if (value.workspace) {
      const ws = value.workspace
      if (ws.published) {
        lines.push(
          `快照：${ws.changed} 处改动 → 分支 ${ws.branch}` +
            (ws.aheadOfRemote
              ? `（含未推送提交，本地 HEAD ${String(ws.localHead ?? '').slice(0, 7)}）`
              : '')
        )
      } else if (ws.changed === 0) {
        lines.push(
          `⚠️ 快照为空：工作区与远端基准一致，包基于 ${String(ws.baseSha ?? '').slice(0, 7)} 构建`
        )
      }
    } else if (value.succeeded) {
      lines.push('提示：未指定 workspaceDir，包基于已推送的代码构建')
    }
    if (value.package) {
      const size = value.package.bytes ? `${(value.package.bytes / 1024).toFixed(1)} KiB` : '?'
      lines.push(`包 ${value.package.name}  ${size}`)
      if (value.package.sha256) lines.push(`SHA256 ${value.package.sha256}`)
    }
    if (value.release) {
      lines.push(`Release ${value.release.tag ?? ''} ${value.release.url ?? ''}`)
    }
    if (value.committed) {
      lines.push(`已提交到 ${value.repo}@${value.commitBranch}`)
    }
    if (value.output) {
      lines.push('')
      lines.push('----- 构建输出 -----')
      lines.push(value.output)
    }
    if (value.failureHints?.length) {
      lines.push('')
      lines.push('----- 失败线索 -----')
      for (const hint of value.failureHints) lines.push(hint)
    }
    if (value.note) {
      lines.push('')
      lines.push(value.note)
    }
    return lines.join('\n')
  }

  // doctor: a checklist reads better than JSON.
  if (value && Array.isArray(value.checks)) {
    const lines = [`Build-Runner 自检：${value.ok ? '全部通过 ✅' : '存在问题 ❌'}`, '']
    for (const check of value.checks) {
      lines.push(`${check.ok ? '✅' : '❌'} ${check.name}: ${check.detail}`)
    }
    return lines.join('\n')
  }

  // workspace publishing result
  if (value && typeof value === 'object' && 'changed' in value && !('conclusion' in value)) {
    const lines = []
    if (value.published === false && value.dryRun) {
      lines.push(`🔍 干跑：将上传 ${value.changed} 个改动文件`)
    } else if (value.published === false) {
      lines.push(`ℹ️ 工作区干净：${value.note ?? '没有未提交改动'}`)
    } else {
      lines.push(`📤 已发布快照：${value.changed} 个改动 → ${value.branch}`)
    }
    lines.push(`仓库 ${value.repo}  基准 ${value.baseRef} → ${String(value.baseSha).slice(0, 7)}`)
    if (value.sha) lines.push(`快照 commit ${String(value.sha).slice(0, 7)}`)
    if (value.summary) {
      const s = value.summary
      lines.push(
        `改动统计：新增 ${s.added}、修改 ${s.modified}、删除 ${s.deleted}、重命名 ${s.renamed}` +
          (value.uploadedBytes ? `，上传 ${(value.uploadedBytes / 1024).toFixed(1)} KiB` : '')
      )
    }
    if (Array.isArray(value.files) && value.files.length > 0) {
      lines.push('', '----- 将上传 -----')
      for (const file of value.files.slice(0, 50)) {
        lines.push(`${file.kind.padEnd(9)} ${file.path}${file.size ? ` (${file.size} B)` : ''}`)
      }
      if (value.files.length > 50) lines.push(`… 另有 ${value.files.length - 50} 个`)
    }
    return lines.join('\n')
  }

  if (value && typeof value === 'object' && 'exists' in value) {
    if (!value.exists) return `构建分支 ${value.branch} 尚未创建（${value.repo}）`
    return [
      `构建分支 ${value.branch} → ${String(value.sha).slice(0, 7)}`,
      `仓库 ${value.repo}`,
      `说明 ${value.message ?? '-'}`,
      `时间 ${value.date ?? '-'}`,
      `链接 ${value.url}`,
    ].join('\n')
  }

  if (value && typeof value === 'object' && 'conclusion' in value && 'output' in value) {
    const lines = []
    const verdict =
      value.succeeded === true
        ? '✅ 成功'
        : value.conclusion === 'cancelled'
          ? '⛔ 已取消'
          : value.conclusion
            ? `❌ 失败（${value.conclusion}）`
            : '⏳ 未完成'
    lines.push(`${verdict}  exit=${value.exitCode ?? 'n/a'}  ${value.durationSeconds ?? '?'}s`)
    lines.push(`仓库 ${value.repo ?? '?'} @ ${value.ref ?? '?'}${value.revision ? ` (${value.revision})` : ''}`)
    if (value.mode === 'snapshot' && value.workspace) {
      const ws = value.workspace
      // There is no branch any more: changes travel as a patch. Say which
      // transport carried it, since a fallback means the primary path failed.
      const how =
        ws.transport === 'contents'
          ? '，已用 contents 通道传输'
          : ws.patchRef
            ? '，已传到引擎仓库补丁分支'
            : ''
      lines.push(
        `⚠️ 快照模式：包含 ${ws.changed} 处改动（基准 ${String(ws.baseSha).slice(0, 7)}` +
          `${ws.aheadOfRemote ? '，含未推送提交' : ''}${how}）。` +
          '这是预检结果，不等同于已推送代码的构建。'
      )
    }
    if (value.runUrl) lines.push(`运行 ${value.runUrl}`)
    lines.push('')
    lines.push('----- 输出 -----')
    lines.push(value.output && value.output.length > 0 ? value.output : '（无输出）')
    if (value.outputTruncated) {
      lines.push('')
      lines.push('（输出已截断，完整日志见上面的运行链接）')
    }
    if (value.failureHints?.length) {
      lines.push('')
      lines.push('----- 失败线索 -----')
      for (const hint of value.failureHints) lines.push(hint)
    }
    if (value.artifacts?.length) {
      lines.push('')
      lines.push('----- 产物 -----')
      for (const item of value.artifacts) lines.push(`${item.name} (${item.sizeBytes} B)`)
    }
    // Released artifacts, when the run also published.
    if (value.package) {
      lines.push('')
      lines.push('----- 发布包 -----')
      const size = value.package.bytes ? `${(value.package.bytes / 1024).toFixed(1)} KiB` : '?'
      lines.push(`${value.package.name}  ${size}`)
      if (value.package.sha256) lines.push(`SHA256 ${value.package.sha256}`)
    }
    if (value.release) {
      lines.push(`Release ${value.release.tag ?? ''} ${value.release.url ?? ''}`)
    }
    if (value.note) {
      lines.push('')
      lines.push(value.note)
    }
    return lines.join('\n')
  }
  return JSON.stringify(value, null, 2)
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message

  // Notifications carry no id and must never be answered.
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('client initialized')
    return
  }

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })

    case 'ping':
      return reply(id, {})

    case 'tools/list':
      return reply(id, { tools: TOOLS })

    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (!TOOLS.some(tool => tool.name === name)) {
        return replyError(id, -32602, `未知工具：${name}`)
      }
      try {
        const value = await invoke(name, args)
        // A tool may return raw MCP content blocks (currently only the
        // screenshot, which must be an `image` block for the model to SEE it).
        if (value && Array.isArray(value.__imageContent)) {
          return reply(id, {
            content: value.__imageContent,
            isError: false,
          })
        }
        return reply(id, {
          content: [{ type: 'text', text: render(value) }],
          // Structured copy so programmatic callers do not have to parse prose.
          structuredContent: value,
          isError: false,
        })
      } catch (error) {
        // A tool failure is a normal result with isError, not a protocol error:
        // the AI must see the message and be able to retry.
        return reply(id, {
          content: [
            {
              type: 'text',
              // Include the stack: a bare message ("effectiveRef is not defined")
              // says nothing about which call site broke, and this server runs as
              // a child process where the caller cannot attach a debugger.
              text:
                `build-runner 执行失败：${error.message}` +
                (error.stack
                  ? `\n\n----- stack -----\n${String(error.stack).split('\n').slice(1, 12).join('\n')}`
                  : ''),
            },
          ],
          isError: true,
        })
      }
    }

    case 'resources/list':
      return reply(id, { resources: [] })
    case 'prompts/list':
      return reply(id, { prompts: [] })

    default:
      return replyError(id, -32601, `不支持的方法：${method}`)
  }
}

function main() {
  log(`starting v${SERVER_INFO.version}`)
  if (!process.env.BUILD_RUNNER_TOKEN) {
    log('WARNING: BUILD_RUNNER_TOKEN 未设置，所有调用都会失败')
  } else {
    log(`token loaded (${process.env.BUILD_RUNNER_TOKEN.length} chars)`)
  }

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })

  // Requests are async (a cloud run can take minutes). Tracking them keeps a
  // client that writes everything then closes stdin — which a piping caller
  // does — from having its in-flight result discarded by the exit below.
  const pending = new Set()

  rl.on('line', line => {
    const text = line.trim()
    if (text === '') return
    let message
    try {
      message = JSON.parse(text)
    } catch {
      log('无法解析的输入行，已忽略')
      return
    }
    const task = handle(message)
      .catch(error => {
        log(`处理 ${message?.method ?? '?'} 时异常：${error.stack ?? error.message}`)
        if (message?.id !== undefined && message?.id !== null) {
          replyError(message.id, -32603, error.message)
        }
      })
      .finally(() => pending.delete(task))
    pending.add(task)
  })

  rl.on('close', async () => {
    if (pending.size > 0) {
      log(`stdin closed, waiting for ${pending.size} in-flight request(s)`)
      await Promise.allSettled([...pending])
    }
    log('exiting')
    process.exit(0)
  })
}

main()
