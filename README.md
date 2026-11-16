# Build-Runner MCP

**把 GitHub Actions 当作你的云端构建机。**

AI 指定「仓库 + 分支 + 命令」，在云端检出那份代码、执行命令，
把 **stdout/stderr 和真实退出码原样返回**。效果等同于本地有环境。

```
AI  ──MCP──▶  build-runner-mcp (本地 stdio)  ──REST──▶  GitHub Actions
                    ▲                                        │
                    └────────  stdout/stderr/exit code ───────┘
```

> 这是 **客户端**（MCP 服务器，装在你的机器上）。
> 服务端 / 云端引擎在另一个仓库：[Ckarefulon/Build-Runner](https://github.com/Ckarefulon/Build-Runner)。

---

## 它解决什么问题

AI 在本地改代码，但你的机器往往**没有构建环境**：没 JDK、没 Android SDK、没 Xcode、
没那个特定版本的运行时。没有环境，AI 只能「猜这段代码应该能过」——这不是自检，是赌博。

Build-Runner 让 AI 把命令丢到云端跑，拿回真实结果。

**目标仓库零改动**：云端引擎在你指定的仓库外执行，不需要给它加任何 workflow 文件。
任何仓库（别人的、私有的）都能立刻用。

---

## 快速开始

### 1. 你要有一个云端引擎

本客户端依赖一个已部署的 [Build-Runner](https://github.com/Ckarefulon/Build-Runner) 仓库
（它承载两个 workflow）。如果没有，先 fork 或使用现成的：

```bash
git clone https://github.com/Ckarefulon/Build-Runner.git
# 推到你的账号下，它就是你的云端引擎
```

### 2. 准备 token

需要 `repo` + `workflow` 权限：

```bash
export BUILD_RUNNER_TOKEN=$(gh auth token)
```

如果目标仓库是**私有**的，在引擎仓库配置一个 secret，让云端能读取它：

```bash
gh secret set CHECKOUT_TOKEN --repo <你的账号>/Build-Runner
```

### 3. 接入 MCP 客户端

运行时**零依赖**，只要 Node >= 20，无需 `npm install`。

```jsonc
{
  "mcpServers": {
    "build-runner": {
      "command": "node",
      "args": ["/绝对路径/Build-Runner-MCP/src/server.js"],
      "env": {
        "BUILD_RUNNER_TOKEN": "ghp_xxx",
        "BUILD_RUNNER_REPO": "你的账号/Build-Runner"
      }
    }
  }
}
```

配置位置随客户端而异：Claude Desktop 是 `claude_desktop_config.json`，
Cursor 是 `~/.cursor/mcp.json`。

### 4. 第一次调用

```
doctor  →  确认 token / 引擎仓库 / workflow 都正常
run     →  {"repo": "你的账号/目标仓库", "command": "node -v && pnpm -v"}
```

---

## 工具

| 工具 | 用途 |
|---|---|
| `run` | 云端执行命令，返回输出与退出码 |
| `release` | 构建 → 打包 → 提交仓库根目录 → 发 GitHub Release |
| `prepare_workspace` | 把本地未提交改动发布到构建分支（`dryRun` 可预览） |
| `workspace_status` | 查看构建分支当前指向 |
| `workspace_reset` | 重置构建分支 |
| `status` | 查询某次运行 |
| `cancel` | 取消运行，停止消耗 Actions 分钟 |
| `doctor` | 自检配置 |

### `run`

```jsonc
{
  "repo": "owner/name",          // 必填，也接受完整 GitHub URL
  "ref": "main",                 // 分支/标签/commit SHA
  "command": "pnpm build",       // 必填，可多行
  "shell": "bash",               // bash | pwsh | python
  "runner": "ubuntu-latest",     // windows-latest / macos-latest / macos-14 …
  "setup": "pnpm install",       // 主命令前的准备步骤
  "timeoutMinutes": 30,
  "workspaceDir": "/path/to/repo" // 可选：开启快照模式，见下
}
```

---

## 快照模式：不提交也能构建

给 `run` 传 `workspaceDir`。**本地改完不用 commit、不用 push。**

```jsonc
{
  "repo": "owner/name",
  "workspaceDir": "/path/to/repo",
  "command": "gradle assembleDebug"
}
```

### 为什么不慢

内容本来就在 GitHub 上，不需要从本地重传。

```
本地 git status  →  只有 3 个文件变了
      ↓  只上传这 3 个 blob
GitHub 用 base_tree 把其余文件在服务端拼进来
      ↓
在目标仓库的 build-runner 分支生成 commit（parent = 真实基准 commit）
```

仓库 5000 个文件、改了 3 个，就只传 3 个文件的字节。实测：19 处改动 → 119 KiB。

### 为什么可信

新 commit 的 **parent 是真实的基准 commit**，所以 `git describe`、
`git rev-list --count`、由提交数推导 versionCode 的项目，行为与真提交后完全一致。
tar 包上传做不到这一点。

### 边界

- 只上传 **git 能看见**的文件。`.gitignore` 排除的内容永不出本机 —— 刻意的防泄漏设计。
- 目标仓库会多出一个 `build-runner` 分支，用 `workspace_reset` 可清理。
- 结果是 **预检** 语义（带 `mode: snapshot`），不等同于已推送代码的构建。

### 未推送的提交也能带上

快照**不只是未提交改动**。它对比的是「本地工作树」与「远端基准提交」，
所以你**已经 commit 但还没 push** 的修复同样会被包含。

这一点很重要：如果一个包基于旧代码构建，表面看完全成功，实际却没有任何修复。

```
本地 HEAD 47414be（含修复，未推送）
远端 main 9ab767c（旧代码）
        ↓ 快照对比的是这两者
包内容 = FIXED-BY-COMMIT   ← 修复在里面
```

返回结果里的 `workspace.aheadOfRemote: true` 就是明确的信号。
本地缺少远端基准提交时会**自动 fetch**，而不是直接失败。

---

## 出包

```jsonc
{
  "repo": "owner/name",
  "command": "gradle assembleDebug",
  "artifactPaths": "app/build/outputs/apk/**",
  "commitBranch": "builds",
  "workspaceDir": "/path/to/repo"   // ← 加这个，包才会包含未推送的修复
}
```

> **出包时务必传 `workspaceDir`。** 不传的话云端只签出**已推送**的代码；
> 如果你的修复还留在本地（未提交或未推送），包会基于旧代码构建，
> 而且**看起来完全成功**。返回结果会明确标注是哪种情况。

云端构建 → 打包（zip + SHA256）→ 提交到目标仓库 `builds` 分支根目录 →
在引擎仓库发 GitHub Release 并附资产。**打包在云端完成**，产物不下载回本机。

**刻意的取舍**：包提交到独立 `builds` 分支而非工作分支；构建失败就不出包；
同 tag 重发覆盖资产而不报错；`artifactPaths` 匹配不到文件直接失败。

---

## 性能

实测一次 Gradle 构建的端到端等待：**96.6s → 45.7s**。

| 来源 | 优化 |
|---|---|
| 引擎的工具探测 | 29s → 5s（只探测命令里真正用到的工具） |
| 缓存体积 | 601 MB → 137 MB（只缓存必要的 Gradle 目录） |
| 客户端轮询间隔 | 最长 8s → 2.5s（消除了约 40s 的调度损耗） |

后两项里，第二项属于引擎仓库，第三项属于本仓库。要点：**轮询间隔也是成本**——
一个 50 秒的任务，如果每 8 秒才查一次，调用方平均多等 4 秒，而实际观测到的
损耗远不止平均值。

---

## 本地开发

```bash
npm test                                  # 单元测试（不联网）
node tools/mcp-client.mjs list            # 用 MCP 协议列出工具

# 端到端（需要真实 token + 引擎仓库）
node tools/smoke.mjs
node tools/cross-repo.mjs owner/repo main
SNAPSHOT_E2E_ALLOW_DIRTY=1 node tools/snapshot-proof.mjs
```

`tools/publish.mjs` 通过 GitHub Contents API 同步仓库，适合 git 传输被代理阻断的网络环境。

---

## 常见问题

**派发后拿不到运行结果**
先调 `doctor`。常见原因是引擎仓库的 Actions 被禁用，或 workflow 不在默认分支上。

**私有仓库 checkout 失败（404）**
引擎仓库缺少 `CHECKOUT_TOKEN` secret，或该 token 无目标仓库读权限。

**命令报 `pnpm: command not found`**
workflow 已用 corepack 自动启用；仍失败就在 `setup` 里显式安装。

**Node 报 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`**
网络有 HTTPS 检查型代理。在 MCP 配置的 `args` 里加 `--use-system-ca`。

---

## 已知限制

- **冷启动 25~50 秒**（排队 + 检出），不适合毫秒级命令
- 需要自备一个 Build-Runner 引擎仓库
- 命令输出会进入 Actions 日志，**不要在里面打印密钥**
- Actions 分钟数按仓库计：public 免费，private 消耗额度

## License

MIT
