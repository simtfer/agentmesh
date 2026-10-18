# agentmesh

[English](README.md) · **简体中文**

一个**协议原生适配器**：让一个编码 agent 充当 **master**，指挥一池**异构 worker agent**（OpenCode、Pi、Codex、Gemini、Claude Code 等）。角色由*配置*决定，而不是由 agent 类型决定——所以 OpenCode 可以当 master 驱动 Pi worker，Pi 也可以驱动 OpenCode，代码完全一样。

```
┌─────────────┐   MCP tools    ┌──────────────────────────┐   ACP (JSON-RPC/stdio)   ┌──────────────┐
│ master agent │ ─────────────▶ │ agentmesh adapter        │ ───────────────────────▶ │ worker: pi   │
│ (opencode/pi)│  spawn/dispatch│  • MCP server (in)       │   via acpx runtime       ├──────────────┤
│  ...any MCP  │ ◀───────────── │  • Orchestrator          │ ◀─────────────────────── │ worker:      │
│    client    │   results      │  • Worker registry       │   streamed events        │   opencode   │
└─────────────┘                │  • git-worktree isolation│                          ├──────────────┤
                               └──────────────────────────┘                          │ worker: ...  │
                                                                                      └──────────────┘
```

## 目录

- [为什么是这个形态](#为什么是这个形态)
- [当前状态](#当前状态)
- [安装](#安装)
- [试运行](#试运行)
- [配置](#配置)
- [任务生命周期与 8 态机](#任务生命周期与-8-态机)
- [暴露给 master 的 MCP 工具](#暴露给-master-的-mcp-工具)
- [自托管的 master 技能](#自托管的-master-技能)
- [跨 Worker 交接](#跨-worker-交接)
- [接入真实的 master](#接入真实的-master)
- [命令行](#命令行)
- [远程 Worker Daemon](#远程-worker-daemon)
- [安全与限制](#安全与限制)
- [排障](#排障)
- [架构](#架构)
- [验证](#验证)
- [路线图](#路线图)
- [许可证](#许可证)

## 为什么是这个形态

两个协议承担了重活，我们一个都不重造：

- **ACP（Agent Client Protocol）**——Zed 提出的、用 JSON-RPC over stdio 驱动编码 agent 的开放协议。OpenCode（`opencode acp`）、Pi（`npx pi-acp`）、Gemini、Codex、Claude Code、Cursor、Qwen 等等都能说。我们直接复用 [`acpx`](https://github.com/openclaw/acpx) 当 ACP 客户端，**一套集成驱动全部 worker**。
- **MCP（Model Context Protocol）**——master 借它获得编排能力。适配器把工具（`spawn_worker`、`dispatch_task`……）暴露出去；任何支持 MCP 的 agent 连上来就变成 master，**自身一行代码都不用改**。Pi 1.0 和 OpenCode 都支持 MCP。

这比 agent 编排 IDE（Electron/GUI）和靠 tmux 抓屏的 supervisor 都轻：master 还是普通 agent，worker 还是普通 agent，适配器只是两者之间的协议桥 + 生命周期管理器。

它**不是**什么——免得被用到错误的场景：

- **不是 agent IDE 或 GUI。** 没有桌面端、没有聊天面板、没有可视化画布。master 就是你本来在用的 agent。
- **不是 agent 框架。** 它不定义 agent 循环、提示词格式或模型抽象；它驱动的是已经存在、且会说 ACP 的 agent。
- **不是工作流 / DAG 引擎。** 任务默认是扁平、相互独立的。链式关系只以显式 `handoff` 的形式存在——从一个*已完成*的任务交给下一个。
- **不是沙箱。** 隔离靠 git worktree 加权限模式；它不做容器化，也不对 worker 进程做其他形式的限制。

## 当前状态

已实现并做过端到端验证：**8 态持久化任务机**（SQLite）、**异步任务生命周期**（`task_submit` / `task_wait` / `task_result`……）、面向 worker 权限/交互请求的**人在环路审批流**、用于并行扇出的**有界、加权公平调度器**（队列 TTL、每任务截止时间、可选 profile 权重）、**跨 Worker 交接**（结果注入、脱敏 diff 旁挂、前驱末态 worktree）、自托管的 **master 委派技能**，以及让 worker 跨机器运行的**远程 Worker Daemon**（带认证、可走 TLS）——驱动对象既有**本机真实的 OpenCode 和 Pi**，也有确定性的 mock。详见[验证](#验证)。

## 安装

agentmesh **尚未发布到 npm**，从源码安装：

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh
npm install
```

要求 Node.js ≥ 22.13。真实 worker 还要求本机已安装对应上游 CLI（`pi`、`opencode`……）并完成认证。

仓库根目录自带一份可直接用的 `agentmesh.yaml`：所有命令默认读 `./agentmesh.yaml`，`--config <path>` 可指向别的文件。你可以就地改它，也可以复制到自己的项目旁边再用 `--config` 指定。

## 试运行

```bash
npm run demo     # Scene A：同步委派并等待；Scene B：submit → waiting → approve → succeeded
npm test         # 全离线测试套件（mock；不联网、不产生 API 费用）
npm run smoke    # 通过 stdio 驱动真实 MCP server，跑完整任务生命周期
```

`demo` 结尾会打印 `Scene A CLOSED ✅ | Scene B CLOSED ✅`——即 master→worker→结果 的往返，加上异步审批环。

想在本机跑**真实** agent（提示词极简，成本最低）：

```bash
npm run real    # == npx tsx scripts/real-smoke.ts；opencode + pi 走 submit → wait → result
```

## 配置

`agentmesh.yaml` 的 `profiles` 下每一项描述的都是 master **可以拉起**的 worker。

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
    agent: opencode           # acpx 内置 -> `npx -y opencode-ai acp`
    worktree: true

  # 自定义启动命令 + 模型：
  # - name: opencode-sonnet
  #   driver: acpx
  #   agent: opencode-custom
  #   command: ["npx", "-y", "opencode-ai", "acp"]
  #   model: anthropic/claude-sonnet-4-5
```

`agent` 可以是任何 acpx 内置名（`pi`、`opencode`、`codex`、`claude`、`gemini`、`cursor`、`qwen`、`qoder`……），也可以是自定义 key 搭配 `command`。可选的 `limits:` 块（递归深度、并发、队列、输出与交接字节上限）在 `agentmesh.yaml` 里有内联注释，另见[安全与限制](#安全与限制)。

## 任务生命周期与 8 态机

每次委派都是一个**任务**，走一套持久化状态机：

```
queued ─▶ starting ─▶ running ─▶ succeeded
                        │  ▲
                 waiting│  │ (approve / respond)
                        ▼  │
                       (loops back to running)
   queued (no slot, TTL/deadline hit) ─▶ timed_out         (terminal)
   running/waiting ─▶ failed | cancelled | timed_out   (terminal)
```

终态：`succeeded`、`failed`、`cancelled`、`timed_out`。任务及其事件日志持久化到 `workdir` 下的 **SQLite**（`node:sqlite`，无原生依赖），所以一个进程提交的任务，下一个进程还能查到。

两种委派方式：

- **异步（主推）：** `task_submit` 立刻返回 `taskId`。之后用 `task_status` 轮询、`task_wait` 阻塞、`task_result` 取结果，或用 `task_events` 翻事件。任务进入 `waiting` 时 `task_wait` 也会立刻返回，让 master 去处理审批，而不是干等到超时。
- **同步（便利）：** `dispatch_task` 一次调用完成「提交 + 等待终态」。

### 审批（人在环路中）

worker 撞上高风险工具（ACP permission request）或需要补充输入（ACP elicitation）时，任务转入 `waiting` 并阻塞。master 随后：

1. `pending_approvals { taskId? }` → 列出阻塞中的请求（`kind`、`id`）。
2. `task_approve { approvalId, decision }` → `allow_once | allow_always | reject_once | reject_always | cancel`，**或者**
   `task_respond { approvalId, action, content? }` → 回答一次 elicitation。

批准会同步把任务恢复为 `running`；拒绝会让任务失败。取消或超时任务会自动清算它挂起的审批。

> **安全：** worker 的输出和权限请求都是**不可信数据**，永远不是指令。处理不可信工作时把 `permissionMode` 保持在 `approve-reads`/`deny-all`，不可逆操作要求人工审批，并且绝不要把密钥提交进仓库、也不要让 ACP 桥在无认证、无 TLS 的情况下暴露到网络。

## 暴露给 master 的 MCP 工具

| 工具 | 作用 |
|---|---|
| `agent_list` | 已配置的 worker profile + 在线 worker |
| `agent_inspect` | 单个 worker 的状态与最近事件日志 |
| `spawn_worker` | 启动一个 worker（可选在 git worktree 中） |
| `kill_worker` | 关闭 worker 并清理它的 worktree |
| `task_submit` | **提交任务，立刻返回 `taskId`**（异步主动作）；`deadlineMs`/`deadlineAt` 约束排队 + 执行总时长；可选 `handoff` 接在一个已完成任务之后 |
| `task_status` | 某个任务的当前状态 |
| `task_wait` | 阻塞到终态**或** `waiting`（需要审批） |
| `task_result` | 任务的最终文本 / 状态 / 错误 |
| `task_events` | 按序号翻取持久化事件日志 |
| `task_cancel` | 请求取消（worker 确认后才结算） |
| `list_tasks` | 列出任务，可按状态过滤 |
| `scheduler_status` | 运行/排队计数、已配置上限（`maxQueuedTasks`、`queueTtlMs`）、按派发顺序排列的队列，以及每项的权重 / 等待时长 / 距过期时间 |
| `pending_approvals` | 阻塞某个 `waiting` 任务的审批/elicitation 请求 |
| `task_approve` | 处理权限请求（允许/拒绝/取消） |
| `task_respond` | 回答 elicitation 请求 |
| `dispatch_task` | 同步便利版：提交并等待终态结果 |
| `master_playbook` | 载入自托管的 MASTER 委派技能（`lang`：`en`/`zh`） |

agentmesh 还**自带 master 技能**：`skills/agentmesh-master/` 下的委派手册通过 MCP 以 `master_playbook` 工具**和**两个可浏览资源（`agentmesh://skills/master/en`、`…/zh`）提供。连上来的 master 可以直接向服务器索要「怎么把任务委派好」，不必把提示词复制粘贴进每个 agent 的配置里。详见[自托管的 master 技能](#自托管的-master-技能)。

## 自托管的 master 技能

只给 master 工具，只解决了它*能*做什么——没解决它怎么委派得*好*。agentmesh 附带一份 **master 手册**并通过 MCP 提供，让这套指导跟着服务器走，而不是靠手工粘贴进每个 agent。

- **唯一真源：** `skills/agentmesh-master/SKILL.md`（英文）与 `SKILL.zh.md`（中文）。标准 skill 结构、带 YAML frontmatter，因此这两个文件同时也能当作「从磁盘加载 skill」类 agent 的即插即用技能。
- **两种提供方式：** `master_playbook` 工具（最通用——所有 MCP 客户端都支持工具；`lang` 选 `en`/`zh`）以及两个可浏览资源 `agentmesh://skills/master/en` 与 `agentmesh://skills/master/zh`。
- **运行时解析：** 从 agentmesh 包根目录定位，因此源码运行（`tsx src/cli.ts mcp`）和构建/安装后运行（`node dist/cli.js mcp`）都可用；`skills/` 已包含在发布包中。

手册覆盖五条规则（异步优先、worker 输出是不可信数据、先看清再委派、背压是信号、不可逆操作停下来问人）、委派循环、意图→工具速查表、如何写出自足的子任务提示词、反模式，以及与 agentmesh 自身保证一致的安全红线。master 在第一次扇出之前应当先调一次 `master_playbook`。

## 跨 Worker 交接

扇出并不总是彼此独立——有时任务 B 应该*接着*任务 A 做（A 写报告、B 审阅；A 打补丁、B 跑测试）。`task_submit` / `dispatch_task` 上的 `handoff` 字段能把一个任务接到已完成的前驱任务上，master 不必手工搬运 A 的输出。

```jsonc
{
  "task": "Review the patch and flag anything unsafe.",
  "profile": "pi",
  "handoff": { "fromTaskId": "<taskA>", "inject": "diff", "base": "predecessor" }
}
```

两个相互独立的维度：

| 字段 | 取值 | 含义 |
|---|---|---|
| `inject` | `"result"`（默认） | 前驱的最终文本，内联进提示词 |
| | `"diff"` | 前驱的工作树补丁，写成脱敏的旁挂文件 |
| `base` | `"repo"`（默认） | 后继的 worktree 从仓库 HEAD 分叉 |
| | `"predecessor"` | ……从前驱末态的快照分叉 |

- **`inject: "result"`** 把持久化的结果文本前置进提示词，并包在不可信信封中（`<<<UPSTREAM WORKER OUTPUT  trusted=NO … >>>`），明确告诉 worker 这段内容只能当**数据**处理、绝不当作指令。另一个 worker 的输出不是指令通道。
- **`inject: "diff"`** 不把补丁塞进提示词。它捕获前驱的工作树差异——已跟踪文件的改动*以及*新增的未跟踪文件，遵守 `.gitignore`——用正则脱敏（`AKIA…`、`ghp_…`、`sk-…`、`xox…`、`Bearer …`、PEM 私钥、`password = …` 这类赋值），按上限裁剪，然后写入 `<workdir>/handoffs/<taskId>.diff`。提示词里只给路径，所以几 MB 的补丁也不需要塞进 prompt。脱敏是**兜底**：它降低意外泄漏的概率，但**不构成保证**，产物依然是不可信数据。
- **`base: "predecessor"`** 把前驱的工作树打成一份 commit 快照（`git write-tree` + `commit-tree`，用临时 index），后继的 worktree 从这份快照分叉——于是后继**真的**从前驱停下的地方开始，连未提交的改动都在。前驱的分支、index 和工作区不会被改动。要求后继在 worktree 里运行（否则 `handoff_base_requires_worktree`）。
- **设计上即瞬态。** 增强后的提示词在运行时拼好；*存储的* `prompt` 仍是 master 提交时的原文。持久化的只有一份精简的 `metadata.handoff` 摘要（`fromTaskId`、`inject`、`base`、`injectedBytes`、`truncated`、`filesChanged`、`addedLines`、`deletedLines`、`redactions`、`artifact`）和一个 `handoff` 事件。
- **准入校验。** 源任务未知 → `handoff_unknown_task`；源未达 `succeeded` → `handoff_predecessor_not_ready`；远程后继碰上产物类交接 → `handoff_artifact_unavailable`；`base: "predecessor"` 但前驱工作树已消失或跨仓 → `handoff_base_unavailable`。全部**不启动 worker**。
- **字节上限。** `handoff.maxBytes`（缺省回落到 `limits.maxHandoffBytes`，默认 256 KiB），在 UTF-8 边界截断并标 `truncated`。

> diff 交接与前驱快照假设后继与 master 在同一台机器上。`driver: remote` 的后继看不到这两类产物，所以 agentmesh 直接拒绝这种组合，而不是给它一个读不到的路径。

## 接入真实的 master

先构建，再把 master agent 的 MCP 配置指向这个服务器。命令固定为：`node <abs>/dist/cli.js mcp --config <abs>/agentmesh.yaml`。

```bash
npm run build
```

**OpenCode**（`opencode.json` / `~/.config/opencode/opencode.json`）——结构如下：

```json
{
  "mcp": {
    "agentmesh": {
      "type": "local",
      "command": ["node", "/ABS/PATH/agentmesh/dist/cli.js", "mcp", "--config", "/ABS/PATH/agentmesh/agentmesh.yaml"],
      "enabled": true
    }
  }
}
```

**Pi**（`.pi/settings.json` 或 `~/.pi/agent/settings.json`）——Pi 1.0 原生支持 MCP；把 agentmesh 作为本地/stdio MCP server 加进去，命令同上。

> 具体的 MCP server 配置键请以当前 OpenCode/Pi 文档为准——上面那行命令才是关键，且是稳定的。

之后直接跟 master 说话即可：*“spawn an opencode worker to fix the failing tests while a pi worker writes the changelog.”* 它会去调 `dispatch_task`。

## 命令行

```bash
npx tsx src/cli.ts demo
npx tsx src/cli.ts list     --config agentmesh.yaml
npx tsx src/cli.ts mcp      --config agentmesh.yaml

# 同步：委派并等待
npx tsx src/cli.ts dispatch --profile pi --task "fix the auth bug" --worktree

# 异步任务生命周期（持久化到 SQLite）
npx tsx src/cli.ts submit   --profile pi --prompt "fix the auth bug"   # 打印 taskId
npx tsx src/cli.ts tasks    --config agentmesh.yaml
npx tsx src/cli.ts approve  --approval-id A --decision allow_once

# 在另一台机器上跑 worker（见「远程 Worker Daemon」）
npx tsx src/cli.ts daemon   --config agentmesh.yaml --host 127.0.0.1 --port 8790 \
  --token-env AGENTMESH_DAEMON_TOKEN
```

> 注意：一次性 CLI 的 `submit` 会持久化任务，但它的实时运行会随进程结束而终止。真正要做异步，请通过长期驻留的 `mcp` server（或一个常驻 orchestrator）提交，让任务在后台继续跑。

## 远程 Worker Daemon

把 worker 跑在另一台机器上——GPU 机器、构建服务器、同事的 checkout——同时**绝不把 ACP stdio 桥放到网络上**。Daemon 把**同一套**本地栈（Orchestrator + TaskManager + acpx 驱动）包在一个带认证的 HTTP+WebSocket 端点后面；在 master 侧，远程 worker 就是一个普通的 `driver: remote` profile，所以派发、审批、事件和持久化行为与本地 worker 完全一致。

```
master (machine A)                              worker daemon (machine B)
  driver: remote    ── WSS + Bearer token ──▶   agentmesh daemon
  RemoteWorkerDriver ◀── typed task events ──    HTTP /healthz,/profiles · WS /ws
                                                 local Orchestrator + acpx ──▶ ACP stdio (LOCAL ONLY)
```

在 B 机上启动（`agentmesh daemon --token-env … --tls-cert … --tls-key …`），在 A 机上用一个 `driver: remote` profile 指向它。保证的简版：token 只从环境变量来（绝不进配置或版本库）、非 loopback 绑定强制 TLS、`daemon.allowCwd` 白名单限定远程任务可运行的目录、连接断开一律清算为 `cancelled`（绝不假报 `succeeded`）、仍在运行的任务可以恢复而不是重跑，并且控制面的每个决定都写入 NDJSON 审计日志、密钥只留不可逆指纹。

**完整指南**——daemon 参数、`driver: remote` profile、重连与对账（`queryRemoteTask`、`attachRemoteTask`、透明 `resume`）、完整的远程安全模型、密钥轮换，以及远程测试覆盖：**[docs/remote.md](docs/remote.md)**（英文）。

## 安全与限制

这些护栏适用于任何部署，无论本地还是远程。（远程特有的安全——token 认证、零停机密钥轮换、cwd 白名单、TLS 与审计轨迹——见 [docs/remote.md](docs/remote.md#security-model)。）

- **worker 输出是不可信数据。** worker 返回的一切——结果文本、权限请求、elicitation 提示，以及任何交接产物——都当作要处理的数据，而不是要服从的指令。交接注入之所以包在 `trusted=NO` 信封里，正是这个原因。处理不可信工作时用 `permissionMode: approve-reads`/`deny-all`，不可逆操作要求人工审批。
- **递归守卫。** master 自己也是 agent，所以委派链（或 master↔worker 环）可能无限递归。`limits.maxDelegationDepth`（默认 8）给它封顶：agentmesh 从 `$AGENTMESH_DELEGATION_DEPTH` 读取自己的层级（顶层 master 为 0），并把它注入到每一个自己拉起的 agent，因此嵌套的 agentmesh 能跨进程边界继承链深。有效深度达到上限的提交会以 `delegation_depth_exceeded` 失败，且**不启动 worker**；调用方标记的深度只能抬高它，永远不能压低继承来的基线。
- **资源上限。** 另有两个护栏约束一个繁忙或失控 master 的影响半径。`limits.maxConcurrentTasks`（默认不限）限制同时运行的任务数。`limits.maxOutputBytes`（默认 1 MiB）限制每任务持久化的结果文本：超出的结果会在 UTF-8 边界截断（绝不切开多字节码点），记录标记 `outputTruncated`，并额外记一条截断事件，让裁剪可观测而不是静默发生。`limits.maxHandoffBytes`（默认 256 KiB）限制跨 Worker 交接可以往前继提示词里注入多少前驱结果，用的是同一套 UTF-8 安全裁剪。
- **有界、公平的调度器。** 每个槽位都忙时新提交会怎样，由 `limits.maxQueuedTasks` 决定。留在 `0`（默认）：提交立刻被拒，返回 `concurrency_limit_exceeded`，且**不启动 worker**——纯背压，扇出突发撑不爆主机。设为 `>0` 则开启真正的调度：超限提交停进有界队列，随运行中任务结算自动排空，只有队列也满了才拒（`queue_full`）。队列只有一个所有者（`pump()`），槽位一释放就推进，因此同一 tick 内的突发也不会产生竞态。排队任务不占 worker，且可以取消——它立即结算，而不必等取消宽限期。`scheduler_status` 工具暴露运行/排队计数、上限，以及按派发顺序排列的队列，master 扇出前可以先读背压。
- **排队的工作有保质期。** `limits.queueTtlMs` 限制一个任务能*等*多久：到期即离队并结算为 `timed_out`，错误 `queue_ttl_exceeded`，自始至终没启动过 worker。每任务截止时间更强——`task_submit { deadlineMs }`（从提交起算的预算）或 `{ deadlineAt }`（绝对 epoch 毫秒）覆盖排队**和**执行，所以再深的积压也不能悄悄吹掉一个墙钟承诺：任务无论仍在排队还是已在运行，都会结算为 `timed_out` 且错误为 `deadline_exceeded`；提交时就已经过期的截止时间直接拒收。运行计时器取 `timeoutMs` 与截止剩余量的**较小值**，两个预算互相配合而不是互相打架。
- **加权公平队列。** profile 权重默认为 `1` 时队列是严格 FIFO（提交顺序 == 派发顺序）。给某个 profile 设 `weight`，调度器就切换成按 finish tag 的加权公平队列（`tag = max(pass[profile], virtualTime) + 1/weight`）：在争用下，`weight: 3` 的 profile 拿到的派发槽位大约是 `weight: 1` 的三倍；而虚拟时间按*被服务*推进，所以后到者无法凭一个陈旧 tag 插到积压前面。权重只重排*等待中*的工作——永远不会让同时运行数超过 `maxConcurrentTasks`。

## 排障

每个失败都会同时落到任务记录（`error.code`）**和**事件日志上，所以 `task_result` / `task_events` 能告诉你**为什么**，而不只是失败了。

| `error.code` | 发生了什么 | 怎么办 |
|---|---|---|
| `concurrency_limit_exceeded` | 槽位全忙，且 `maxQueuedTasks` 为 `0` | 等某个任务结算后重试，或设 `maxQueuedTasks > 0` 改为排队而非拒绝 |
| `queue_full` | 槽位全忙**且**队列已达 `maxQueuedTasks` | 调大 `maxQueuedTasks`，或拆小批次；`scheduler_status` 可看积压 |
| `queue_ttl_exceeded` | 等待超过 `queueTtlMs` 且从未启动 | 调大 `queueTtlMs`、加容量，或拆批 |
| `deadline_exceeded` | 触到 `deadlineMs`/`deadlineAt`——可能在排队中，也可能在运行中 | 给更大预算；若它全程没启动过，那是容量问题，不是任务问题 |
| `task_timeout` | 运行超过 `timeoutMs`（不涉及截止时间） | 给长回合调大 `timeoutMs` |
| `delegation_depth_exceeded` | 委派链达到 `maxDelegationDepth` | 通常是 master 在循环委派——先查链路再考虑抬上限 |
| `handoff_unknown_task` | `handoff.fromTaskId` 找不到对应任务 | 核对 id；另一个 `workdir` 下的任务在这里不可见 |
| `handoff_predecessor_not_ready` | 前驱任务还没到 `succeeded` | 先 `task_wait` 它；失败/取消的输出永远不会被交接 |
| `handoff_base_requires_worktree` | 用了 `base: "predecessor"` 但没开 worktree | 提交时传 `worktree: true`，或在 profile 上开启 |
| `handoff_base_unavailable` | 前驱的工作树已消失，或不在同一个仓库 | 在先继任任务启动前别杀掉前驱 worker |
| `handoff_artifact_unavailable` | 对远程 worker 用了 `diff`/`predecessor` 交接，或工作树已不存在 | 让后继在本机跑，或改用 `inject: "result"` |

不是错误码的常见症状：

- **任务一直卡在 `waiting`。** 它被权限或 elicitation 请求阻塞了——调 `pending_approvals`，然后 `task_approve` / `task_respond`。`task_wait` 会在这种情况发生时立即返回，这是设计如此。
- **`dispatch_task` 看起来卡死。** 它会一直等到终态，所以需要审批的任务在里面永远推不动。可能有人工介入时，改用 `task_submit` + `task_wait`。
- **`cli submit` 退出了但任务没继续。** 符合预期：一次性 CLI 的实时运行随进程结束。要做真正的异步，用长期驻留的 `mcp` server（[命令行](#命令行)里也提到了）。
- **daemon 拒绝连接或返回 401。** 绑定/TLS/token 规则见 [docs/remote.md](docs/remote.md#security-model)；token 必须来自 `--token-env` 指定的环境变量。

## 架构

```
src/
  index.ts             包的公开入口（`package.json#exports` 指向的 API 表面）
  types.ts             领域类型（WorkerProfile、TaskRecord、TaskStatus、TaskEvent……）
  config.ts            YAML 加载 + zod 校验
  statemachine.ts      8 态转移 + 终态/合法性守卫
  worktree.ts          并行 worker 的 git worktree 隔离
  handoff.ts           diff 捕获、密钥脱敏、末态快照、旁挂文件
  registry.ts          worker 生命周期 + 有界事件日志
  approvals.ts         ApprovalBroker：把权限/elicitation 桥接给 master
  tasks.ts             TaskManager：异步 8 态生命周期、超时/取消、审批、交接
  store/
    memory.ts          内存版 TaskStore（测试、persist:false）
    sqlite.ts          基于 node:sqlite 的持久化 TaskStore（默认）
  orchestrator.ts      核心门面：worker + 任务 + store + 驱动
  drivers/
    factory.ts         按 profile 选驱动（acpx/remote 惰性构造）
    acpxDriver.ts      经 acpx runtime 的真实 ACP worker（含权限/elicitation 钩子）
    mockDriver.ts      确定性离线 worker（demo/测试，含 requireApproval）
  remote/
    protocol.ts        带版本号的线缆消息（submit/approve/respond/cancel + 事件）
    security.ts        token 比较、cwd 白名单、TLS 加载、安全绑定守卫
    daemon.ts          WorkerDaemon：包住本地 Orchestrator 的 HTTP+WS 外壳
    client.ts          RemoteWorkerDriver：把远程 profile 当普通 WorkerDriver 用
    audit.ts           追加写 NDJSON 审计日志；密钥降为指纹
  mcp/server.ts        把 orchestrator 暴露为 17 个 MCP 工具（stdio）
  skill.ts             从 skills/ 加载自托管 master 手册（包根解析器）
  cli.ts               demo | list | mcp | dispatch | submit | tasks | daemon
skills/
  agentmesh-master/    master 委派手册（SKILL.md + SKILL.zh.md），
                       经 MCP 以 master_playbook 工具 + 资源提供
scripts/
  mcp-smoke.mjs        通过 stdio 驱动真实 MCP server（`npm run smoke`）
  real-smoke.ts        驱动真实的 opencode + pi worker（`npm run real`）
docs/
  remote.md            远程 Worker Daemon 完整指南
  verification.md      逐项测试的完整验证记录
  PLAN.md              设计笔记 + 路线图
```

**角色对称：** 代码里没有任何地方写死「opencode 才是 master」。谁挂上 MCP server 谁就是 master，谁被适配器驱动谁就是 worker。两者对调，依然成立。

## 验证

```bash
npm run typecheck   # tsc --noEmit，干净
npm test            # 72 个测试，全离线，无 API 费用，约 22 秒
npm run demo        # Scene A + Scene B 均闭环
npm run smoke       # 真实 MCP server 走 stdio 跑完整生命周期
npm run real        # 本机真实的 opencode + pi（两者都需已安装并认证）
```

`npm test` 为 **72/72**，分五个文件——生命周期、持久化与守卫（32），交接产物（12），远程 daemon（18），orchestrator（6），master 技能（4）。每个用例都驱动公开接口（Orchestrator、MCP 工具，或 daemon 的 HTTP/WS 端点）并断言最终任务记录，而不是断言 mock 的内部调用。

最近一次在 Windows + Node v22.22 上运行。真实的 OpenCode 与 Pi worker 也已端到端跑通（`npm run real`：两者都到达 `succeeded`，共持久化 2 个任务 / 27 条事件）。

逐项明细、复现步骤，以及**尚未覆盖**的已知缺口，都在
[docs/verification.md](docs/verification.md)（英文）。

## 路线图

已完成：

- ✅ 异步任务生命周期 + 8 态机 + SQLite 持久化。
- ✅ 人在环路审批（权限 + elicitation），经 broker 实现。
- ✅ 真实 ACP worker（OpenCode、Pi）端到端验证。
- ✅ 远程 Worker Daemon：在另一台机器上跑 worker，走认证、可 TLS 的通道（ACP stdio 永不过网）。
- ✅ 递归守卫 + 资源上限（委派深度、并发、输出大小）。
- ✅ 有界 FIFO 调度器：并行扇出、单一队列所有者、超限排队，以及 `scheduler_status` 观测。
- ✅ 队列 TTL + 每任务截止时间（`deadlineMs` / `deadlineAt`，覆盖排队等待 + 执行）与跨 profile 加权公平（用 `weight` 选择性开启）。
- ✅ 自托管 master 技能：委派手册随仓库发布，并通过 MCP（`master_playbook` 工具 + 资源）提供，master 默认就能委派得体，无需任何复制粘贴。
- ✅ 跨 Worker 交接（Phase 1–3）：把任务接在已完成前驱的 `result` 上；把前驱的工作树 `diff` 作为脱敏旁挂文件交接，而不是把补丁塞进 prompt；让后继的 worktree 从前驱末态的快照分叉。注入的产物一律按不可信数据、受字节上限约束，存储的 prompt 保持原样。

接下来：

- 结构化结果契约（每任务的 JSON 输出 schema）+ 从 ACP `usage_update` 事件汇总成本/用量。

这些决定背后的设计笔记、被否决的替代方案与分阶段构建过程：[docs/PLAN.md](docs/PLAN.md)（英文）。

## 许可证

MIT
