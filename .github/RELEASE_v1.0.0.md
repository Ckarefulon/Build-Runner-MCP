# Build-Runner MCP v1.0.0

**把 GitHub Actions 当作你的云端构建机。** AI 指定「仓库 + 分支 + 命令」，
云端执行并原样返回 **stdout/stderr 与真实退出码**。

解决的问题：AI 在本地改代码，但你的机器往往没有构建环境（没 JDK、没 Android SDK、
没 Xcode）。没有环境，AI 只能「猜这段代码应该能过」——这不是自检，是赌博。

```
AI  ──MCP──▶  build-runner-mcp (本地 stdio)  ──REST──▶  GitHub Actions
                    ▲                                        │
                    └────────  stdout/stderr/exit code ───────┘
```

> **这是客户端。** 云端引擎在 [Ckarefulon/Build-Runner](https://github.com/Ckarefulon/Build-Runner)，
> 你需要有一个自己的副本（fork 或 clone 后 push）。

---

## 八个工具

### 跑命令

```jsonc
{ "repo": "owner/name", "ref": "main", "command": "pnpm build" }
```

`exit 42` 就返回 `exitCode: 42`，不会被吞掉。超长输出保留**头 + 尾**（错误通常在尾部）。
分支名写错会在 1.5 秒内报错并提示默认分支，不浪费 runner 时间。

### 不提交也能构建（快照模式）

```jsonc
{ "repo": "owner/name", "workspaceDir": "/path/to/repo", "command": "gradle assembleDebug" }
```

本地改完**不用 commit、不用 push**。

**为什么不慢**：内容本来就在 GitHub 上。本地 `git status` 找出改动的几个文件，
只传这几个 blob，其余由 GitHub 用 `base_tree` 在服务端拼接。
实测 19 处改动只传 119 KiB，而不是整个仓库。

**为什么可信**：新 commit 的 **parent 是真实的基准 commit**，所以 `git describe`、
`git rev-list --count`、由提交数推导 versionCode 的项目，行为与真提交后完全一致。
tar 包上传做不到这一点。

### 出包

```jsonc
{ "repo": "owner/name", "command": "gradle assembleDebug",
  "artifactPaths": "app/build/outputs/apk/**" }
```

云端构建 → 打包（zip + SHA256）→ 提交到目标仓库 `builds` 分支根目录 →
在引擎仓库发 GitHub Release。**打包在云端完成**，产物不下载回本机再上传。

**刻意的取舍**：包提交到独立 `builds` 分支而非工作分支；构建失败就不出包；
同 tag 重发覆盖资产而不报错；`artifactPaths` 匹配不到文件直接失败。

### 其余

`prepare_workspace`、`workspace_status`、`workspace_reset`、`status`、`cancel`、`doctor`。

---

## 安装

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

Token 需要 `repo` + `workflow` 权限（`gh auth token` 即可）。
私有目标仓库还需在**引擎仓库**配置 `CHECKOUT_TOKEN` secret。

---

## 交付质量

- **19 个回归测试**全过，覆盖日志解析（含「不把回显的脚本当输出」这个致命陷阱）
  与 `git status -z` 的编码/改名/中文路径处理
- 三个可复跑的端到端验证脚本：`tools/smoke.mjs`、`tools/cross-repo.mjs`、
  `tools/snapshot-proof.mjs`
- 实测：跨仓库在无 workflow 的仓库上执行成功；Android 环境探测返回 `openjdk 17` +
  `ANDROID_HOME`；构建失败时不产出空包

---

## 已知限制

- **冷启动 25~50 秒**（排队 + 检出），不适合毫秒级命令
- 需要自备一个 Build-Runner 引擎仓库
- 快照模式只上传 **git 能看见**的文件（`.gitignore` 排除的内容永不出本机）
- 快照结果是 **预检** 语义（带 `mode: snapshot`），不等同于已推送代码的构建
- 命令输出会进入 Actions 日志，**不要在里面打印密钥**

**License**: MIT
