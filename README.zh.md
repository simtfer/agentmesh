# agentmesh

[English](https://github.com/simtfer/agentmesh/blob/main/README.md) · **简体中文**

一个**协议原生适配器**：让一个编码 agent 充当 **master**，指挥一池**异构 worker agent**（OpenCode、Pi、Codex、Gemini、Claude Code 等）。角色由*配置*决定，而不是由 agent 类型决定——所以 Claude Code 可以当 master 驱动 Pi worker，OpenCode 可以驱动 Pi，Pi 也可以驱动 OpenCode，代码完全一样。

一个任务就是一次往返——下发、回传、决定下一步——这个循环属于 master，不属于适配器。复用同一个 worker（`workerId`）时，它会在多轮之间保持会话，master 就能和另一台机器上的 worker 真正“接着聊”；把会话固定下来（`session`），这段对话还能活过 daemon 重启；每次开新 worker 的话，能延续下来的只有它运行的那份 checkout，或者一次显式的 `handoff`。

```
┌──────────────┐   MCP tools    ┌──────────────────────────┐   ACP (JSON-RPC/stdio)  ┌──────────────┐
│ master agent │ ─────────────▶ │ agentmesh adapter        │ ──────────────────────▶ │ worker: pi   │
│ (Claude Code)│ spawn/dispatch │  • MCP server (in)       │     via acpx runtime    ├──────────────┤
│  ...any MCP  │ ◀───────────── │  • Orchestrator          │ ◀────────────────────── │ worker:      │
│    client    │    results     │  • Worker registry       │     streamed events     │   opencode   │
└──────────────┘                │  • git-worktree isolation│                         ├──────────────┤
                                └──────────────────────────┘                         │ worker: ...  │
                                                                                     └──────────────┘
```

[![CI](https://github.com/simtfer/agentmesh/actions/workflows/ci.yml/badge.svg)](https://github.com/simtfer/agentmesh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/simtfer/agentmesh/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen.svg)](https://github.com/simtfer/agentmesh/blob/main/package.json)

172 个离线测试，覆盖 Linux 与 Windows · 尚未发布到 npm

## 这是什么

两个协议承担了重活，我们一个都不重造：

- **ACP（Agent Client Protocol）**——Zed 提出的、用 JSON-RPC over stdio 驱动编码 agent 的开放协议。OpenCode（`opencode acp`）、Pi（`npx pi-acp`）、Gemini、Codex、Claude Code、Cursor、Qwen 等等都能说。我们直接复用 [`acpx`](https://github.com/openclaw/acpx) 当 ACP 客户端，**一套集成驱动全部 worker**。
- **MCP（Model Context Protocol）**——master 借它获得编排能力。适配器把工具（`spawn_worker`、`dispatch_task`……）暴露出去；任何支持 MCP 的 agent 连上来就变成 master，**自身一行代码都不用改**。

这比 agent 编排 IDE（Electron/GUI）和靠 tmux 抓屏的 supervisor 都轻：master 还是普通 agent，worker 还是普通 agent，适配器只是两者之间的协议桥 + 生命周期管理器。

它**不是**什么——免得被用到错误的场景：

- **不是 agent IDE 或 GUI。** 没有桌面端、没有可视化画布；团队的房间是 CLI 加一个小 HTTP API。
  master 仍是你本来在用的 agent。
- **不是 agent 框架。** 它不定义 agent 循环、提示词格式或模型抽象；它驱动的是已经存在、且会说 ACP 的 agent。
- **不是工作流引擎。** 任务是扁平的；`dependsOn` 把它们组成一张**静态 DAG**——无环、无条件分支、无循环、无 DSL。任务之间的*产物*传递仍然只走显式 `handoff`。
- **不是沙箱。** 隔离靠 git worktree 加权限模式；它不做容器化，也不对 worker 进程做其他形式的限制。

## 快速开始

agentmesh **尚未发布到 npm**，从源码安装：

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh
npm install
```

然后不需要任何 API key、不产生费用就能跑起来：

```bash
npm run demo     # Scene A：同步委派并等待；Scene B：submit → waiting → approve → succeeded
npm test         # 全离线测试套件（mock；不联网、不产生 API 费用）
npm run smoke    # 通过 stdio 驱动真实 MCP server，跑完整任务生命周期
```

`demo` 结尾会打印 `Scene A CLOSED ✅ | Scene B CLOSED ✅`——即 master→worker→结果 的往返，加上异步审批环。想在本机跑**真实** agent（提示词极简，成本最低）用 `npm run real`——前提是本机已安装并认证 `opencode` 与 `pi`。

## 接入 master

先构建，再把 master agent 的 MCP 配置指向这个服务器：

```bash
npm run build
```

```json
{
  "mcpServers": {
    "agentmesh": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABS/PATH/agentmesh/dist/cli.js", "mcp", "--config", "/ABS/PATH/agentmesh/agentmesh.yaml"]
    }
  }
}
```

上面就是 Claude Code 的形态——项目里的 `.mcp.json`，或者用
`claude mcp add --transport stdio agentmesh -- node …` 写同样的命令。OpenCode 与 Pi
各自在自己的配置里填这条命令即可。之后直接跟 master 说话：*“让 pi worker 加一个 `/health` 端点并跑测试。”*——它会去调 `dispatch_task`。
路径必须是绝对路径：server 是从 master 的 cwd 拉起来的。

各客户端的完整片段（含远程 token 的 `env` 写法）与全部命令：[`docs/cli.md`](https://github.com/simtfer/agentmesh/blob/main/docs/cli.md)（英文）。

## 核心概念

每次委派都是一个**任务**，走一套 8 态持久化状态机，存放在 `workdir` 下的 SQLite 里——所以一个进程提交的任务，下一个进程还能查到：

```
queued ─▶ starting ─▶ running ─▶ succeeded
                        │  ▲
                 waiting│  │ (approve / respond)
                        ▼  │
   queued (no slot, TTL/deadline hit) ─▶ timed_out         (terminal)
   starting/running/waiting ─▶ queued        (retry: another attempt is due)
   running/waiting ─▶ failed | cancelled | timed_out   (terminal)
```

- **异步是主推方式。** `task_submit` 立刻返回 `taskId`；之后用 `task_status` 轮询、`task_wait` 阻塞、`task_result` 取结果、`task_events` 翻事件。`dispatch_task` 是「提交 + 等终态」的同步便利版。
- **审批是一等状态。** worker 撞上高风险工具或需要补充输入时，任务转入 `waiting` 且 `task_wait` 提前返回；master 用 `task_approve` / `task_respond` 作答。
- **worker 输出是不可信数据**，永远不是指令——包括通过 handoff 传进来的一切。

完整状态转移与审批环：[`docs/lifecycle.md`](https://github.com/simtfer/agentmesh/blob/main/docs/lifecycle.md)（英文）。

## 团队：有名字的成员

**团队**把 worker 变成有名字的同事。每个成员是一个固定会话的 agent 进程，有自己的 harness profile、
工作区和 `MEMORY.md`；成员共享房间，`@提及` 把下一轮交给某位队友。成员之间并行，单个成员串行，
每一轮的工具调用都可查看——群聊本身就是界面，而不是它的总结。配了 `pulse` 的成员还会按自己的节奏
醒来，只在真有事说的时候才开口；配了 `claims` 的成员会接**没人点名**的消息，于是发到房间里、
不带 @ 的活能找到主人，而不是换来一句耸肩。`team serve` 同时也是一个只读控制台
（`http://127.0.0.1:4317/`）：成员栏、房间记录、某位成员的逐轮过程，浏览器里就能看，不必守着终端。

```bash
agentmesh team serve &        # 常驻：保住名册与各自的会话（同时提供控制台）
agentmesh team chat           # 群聊、私聊、/transcript <成员>
```

名册、频道、私聊、重启恢复，以及这一层**有意不做**的事：
[`docs/team.zh.md`](https://github.com/simtfer/agentmesh/blob/main/docs/team.zh.md)。

## 配置

`agentmesh.yaml` 描述的是 **worker**；master 是连上来的那个 agent。

```yaml
workdir: .agentmesh          # worktree + acpx 会话状态
defaults:
  permissionMode: approve-all # deny-all | approve-reads | approve-all

profiles:
  - name: mock-analyst        # 确定性、离线
    driver: mock
    mock: { delayMs: 20, toolCalls: 2 }

  - name: pi                  # 走 ACP 的真实 Pi worker
    driver: acpx
    agent: pi                 # acpx 内置 -> `npx pi-acp`
    worktree: true            # 并行编辑时彼此隔离

  - name: opencode            # 走 ACP 的真实 OpenCode worker
    driver: acpx
    agent: opencode
    worktree: true
```

`agent` 可以是任何 acpx 内置名（`pi`、`opencode`、`codex`、`claude`、`gemini`、`cursor`、`qwen`、`qoder`……），也可以是自定义 key 搭配 `command`。所有键——profiles、`limits`、`daemon`——见 [`docs/configuration.md`](https://github.com/simtfer/agentmesh/blob/main/docs/configuration.md)（英文）。

## MCP 工具

stdio 上共 18 个工具。核心循环：

| 分组 | 工具 |
|---|---|
| Worker | `agent_list` · `agent_inspect` · `spawn_worker` · `kill_worker` |
| 任务 | `task_submit` · `task_status` · `task_wait` · `task_result` · `task_events` · `task_cancel` · `list_tasks` |
| 运维 | `scheduler_status` · `usage_summary` · `pending_approvals` · `task_approve` · `task_respond` |
| 便利 | `dispatch_task` · `master_playbook` |

`master_playbook` 提供**自托管的委派手册**（内容同 `skills/agentmesh-master/SKILL.md`，也能作为 `agentmesh://skills/master/en|zh` 资源浏览），所以这套指导跟着服务器走，不必粘进每个 agent 的配置。完整签名：[`docs/mcp-tools.md`](https://github.com/simtfer/agentmesh/blob/main/docs/mcp-tools.md)（英文）。

## 进阶

**跨 Worker 交接**——把任务 B 接在已完成的 A 上：`inject: "result"` 把 A 的文本包进不可信信封内联；`inject: "diff"` 写成脱敏补丁旁挂文件（后继在远程时，补丁随提交一起过网，由 daemon 落到它自己的状态目录）；`base: "predecessor"` 让 B 的 worktree 从 A 的末态分叉——最后这一种仍然只在同一台机器上成立，因为 commit 不是字节。[`docs/handoff.md`](https://github.com/simtfer/agentmesh/blob/main/docs/handoff.md)

**结构化结果与成本**——`outputSchema` 强制 JSON 契约（违约即失败；解析值从 `structured` 返回），ACP `usage_update` 则汇成逐任务与聚合的 token/成本。[`docs/contracts.md`](https://github.com/simtfer/agentmesh/blob/main/docs/contracts.md)

**进阶调度**——`dependsOn` 把任务门控在其他任务之后，`retry` 按退避重跑瞬时失败，`deadlineMs` 同时约束排队与执行，profile `weight` 让队列变成加权公平调度。[`docs/limits.md`](https://github.com/simtfer/agentmesh/blob/main/docs/limits.md)

**远程 worker**——`driver: remote` profile 用 WSS + Bearer token 连接包着同一套核心的 daemon，ACP stdio 永不过网。token 只从环境变量来，非 loopback 绑定强制 TLS，`daemon.tls.ca` 开启 mTLS，`allowCwd` 限定可运行目录，连接断开一律清算为 `cancelled`，控制面的每个决定都写进按大小轮转的 NDJSON 审计日志。[`docs/remote.md`](https://github.com/simtfer/agentmesh/blob/main/docs/remote.md) · 部署手册 [`docs/deploy.md`](https://github.com/simtfer/agentmesh/blob/main/docs/deploy.md)

## 安全与限制

这些护栏适用于任何部署，本地或远程：

- **递归守卫**——`limits.maxDelegationDepth`（默认 8），通过 `$AGENTMESH_DELEGATION_DEPTH` 跨进程继承；达到上限的提交不启动 worker 直接失败。
- **默认背压**——`maxQueuedTasks: 0` 时超限提交直接拒（`concurrency_limit_exceeded`）而不排队；调大才开启真正调度。
- **保质期**——`queueTtlMs` 约束排队等待，`deadlineMs`/`deadlineAt` 约束整个任务，提交时就已过期的截止时间直接拒收。
- **花费天花板**——逐任务 `budget { maxTokens, maxCost }` 在回合中途叫停且永不重试；进程级 `maxTotalTokens`/`maxTotalCost` 只拒**新**提交，已受理的任务照常跑完。
- **审批宽度**——超过 `limits.maxWaitingTasks` 后，权限请求当场被拒而不是挂起。
- **输出上限**——`maxOutputBytes` 在 UTF-8 边界截断并标记 `outputTruncated`，失控 agent 撑不爆存储。

每条护栏的默认值、触发后给什么错误码：[`docs/limits.md`](https://github.com/simtfer/agentmesh/blob/main/docs/limits.md)（英文）。

## 排障

每个失败都会同时落到任务记录（`error.code`）**和**事件日志上，所以 `task_result` / `task_events` 能告诉你**为什么**，而不只是失败了。

| `error.code` | 怎么办 |
|---|---|
| `concurrency_limit_exceeded` | 等某个任务结算后重试，或设 `maxQueuedTasks > 0` |
| `budget_exceeded` | 调高该任务的上限，或把活拆小；它永不重试 |
| `handoff_artifact_unavailable` | 让后继在本机跑，或改用 `inject: "result"` |
| `output_schema_invalid` | 看 `metadata.outputContract.errors` 里的出错路径 |

任务卡在 `waiting` 说明它在等审批，而 `dispatch_task` 推不动它——改用 `task_submit` + `task_wait`。其余 16 个错误码，以及不是错误码的常见症状（daemon 401、TLS 失败）：[`docs/troubleshooting.md`](https://github.com/simtfer/agentmesh/blob/main/docs/troubleshooting.md)（英文）。

## 文档

| | |
|---|---|
| [`configuration.md`](https://github.com/simtfer/agentmesh/blob/main/docs/configuration.md) | `agentmesh.yaml` 的每一个键 |
| [`quickstart.md`](https://github.com/simtfer/agentmesh/blob/main/docs/quickstart.md) · [`quickstart.zh.md`](https://github.com/simtfer/agentmesh/blob/main/docs/quickstart.zh.md) | 十五分钟跑通 A（master）+ B（worker） |
| [`two-host.md`](https://github.com/simtfer/agentmesh/blob/main/docs/two-host.md) · [`two-host.zh.md`](https://github.com/simtfer/agentmesh/blob/main/docs/two-host.zh.md) | A、B 两侧的完整配置与启动 |
| [`cli.md`](https://github.com/simtfer/agentmesh/blob/main/docs/cli.md) | 命令 + 接入 OpenCode / Pi |
| [`team.md`](https://github.com/simtfer/agentmesh/blob/main/docs/team.md) · [`team.zh.md`](https://github.com/simtfer/agentmesh/blob/main/docs/team.zh.md) | 有名字的成员、房间、@ 交接、逐成员过程 |
| [`lifecycle.md`](https://github.com/simtfer/agentmesh/blob/main/docs/lifecycle.md) | 8 态机、委派方式、审批 |
| [`mcp-tools.md`](https://github.com/simtfer/agentmesh/blob/main/docs/mcp-tools.md) | 18 个工具 + 自托管手册 |
| [`handoff.md`](https://github.com/simtfer/agentmesh/blob/main/docs/handoff.md) | 把任务接在前驱输出上 |
| [`contracts.md`](https://github.com/simtfer/agentmesh/blob/main/docs/contracts.md) | JSON 结果契约、用量/成本汇总 |
| [`limits.md`](https://github.com/simtfer/agentmesh/blob/main/docs/limits.md) | 调度器、重试、预算、安全护栏 |
| [`troubleshooting.md`](https://github.com/simtfer/agentmesh/blob/main/docs/troubleshooting.md) | 错误码与症状 |
| [`remote.md`](https://github.com/simtfer/agentmesh/blob/main/docs/remote.md) | 远程 Worker Daemon 完整指南 |
| [`deploy.md`](https://github.com/simtfer/agentmesh/blob/main/docs/deploy.md) | 双机部署手册：CA、mTLS、防火墙、开机启动 |
| [`architecture.md`](https://github.com/simtfer/agentmesh/blob/main/docs/architecture.md) | 分层、源码地图、角色对称 |
| [`verification.md`](https://github.com/simtfer/agentmesh/blob/main/docs/verification.md) | 逐项测试覆盖与已知缺口 |
| [`release.md`](https://github.com/simtfer/agentmesh/blob/main/docs/release.md) | 发布一个版本的步骤与验收 |
| [`PLAN.md`](https://github.com/simtfer/agentmesh/blob/main/docs/PLAN.md) | 设计笔记、被否决的替代方案、路线图 |

## 验证

```bash
npm run typecheck   # tsc --noEmit，干净
npm test            # 176 个测试，全离线，无 API 费用，约 45 秒
npm run demo        # Scene A + Scene B 均闭环
npm run smoke       # 真实 MCP server 走 stdio 跑完整生命周期
npm run check:pack  # 发布包里有 dist/，且不含源码与测试
npm run deploy:tls  # 在本机真实网卡上跑 TLS/mTLS（不走 loopback）
npm run real        # 本机真实的 opencode + pi（两者都需已安装并认证）
```

`npm test` 为 **176/176**，分十二个文件，全离线，约 45 秒。每个用例都驱动公开接口（Orchestrator、MCP 工具，或 daemon 的 HTTP/WS 端点）并断言最终任务记录，而不是断言 mock 的内部调用。CI 在 Linux 与 Windows × Node 22 / 24 上跑同一套关卡（[`.github/workflows/ci.yml`](https://github.com/simtfer/agentmesh/blob/main/.github/workflows/ci.yml)）；真实的 OpenCode 与 Pi worker 也已端到端跑通。逐项明细与**尚未覆盖**的缺口：[`docs/verification.md`](https://github.com/simtfer/agentmesh/blob/main/docs/verification.md)（英文）。

## 路线图

已经可用：基于 SQLite 的异步 8 态生命周期、人在环路审批、真实 ACP worker、有界加权公平调度（含截止时间与 DAG 重试）、跨 Worker 交接（含把 diff 交给另一台机器上的 worker）、强制 JSON 契约与成本汇总、硬性花费预算、自托管委派手册、支持双向 TLS 的远程 daemon，以及团队层（有名字的成员、房间、@ 交接、逐成员过程记录、让成员自己开口的 pulse、只读 Web 控制台）。

接下来：

- **汇报之外的自主**——成员从队列里自己认领活，而不是等着被点名。
- **混合 harness 的实证**——真实 pi + opencode 跑通一条交接链，并补上 `remote` 成员（远端 daemon 而非本地进程）的覆盖。

## 贡献

```bash
npm run typecheck && npm test && npm run build && npm run demo
```

这四件套是每个改动都该通过的关卡；改动 MCP 表面时再加 `npm run smoke`。CI 在 Linux 与 Windows 上跑它，所以这道关卡是被执行的，而不是靠记忆。新测试是 `node:test` 文件，驱动公开接口（orchestrator、MCP 工具、daemon HTTP/WS）并断言任务记录——绝不断言 mock 内部——且每个新文件都要手动加进 `package.json#scripts.test` 的显式列表。文档是双语的：`README.md` 与 `README.zh.md` 结构必须严格一致，深度文档放在 `docs/`。

## 许可证

MIT
