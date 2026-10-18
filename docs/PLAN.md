# Agent Bridge — 整合方案 v1.1

> 本文在你提供的 **v1.0 方案** 基础上整理，叠加**已实现并验证的 `agentmesh` MVP**（当前代码库），
> 对齐术语、数据模型、MCP 工具与路线图，并修正若干参考链接。
>
> - 产品代号：**Agent Bridge**；当前脚手架 npm 包名：`agentmesh`（可低成本重命名）。
> - 一句话架构：**ACP 统一接 Agent（经 acpx）＋ MCP 统一 Master 入口 ＋ 自研 Orchestrator 统一任务生命周期 ＋ Worker Daemon 统一远程执行。**
> - v1.0 的核心判断全部保留；本版主要变化是**用 acpx 复用 ACP 客户端**、**Stage 0/1 已大部分落地**、**修正参考链接**。

---

## 0. 相对 v1.0 的三点整合决策

1. **ACP 客户端复用 `acpx`（openclaw/acpx，3.4k⭐），不自研。**
   v1.0 计划自写通用 ACP Client 并直接依赖第三方 `pi-acp`。实际上 `acpx` 已把最难的部分封装好：
   进程内 runtime、持久/一次性会话、权限模式、取消、重连、NDJSON 事件流，且**内置 agent 注册表**
   （`pi → npx pi-acp`、`opencode → npx -y opencode-ai acp`、`codex/claude/gemini/cursor/qwen/qoder…`）。
   → 采纳 acpx 作为 `adapter-acp` 的实现底座；Pi 原生 RPC/SDK 仍保留为备用 Adapter。

2. **命名与接口对齐**（合并两套）：v1.0 的 `task_*` 受理式语义 **优于** MVP 现在的同步 `dispatch_task`，
   作为目标形态；MVP 的 profile/driver 命名映射到 v1.0 的 agent/adapter。详见 §4、§5。

3. **路线图前移**：Stage 0（协议可行性）已被 acpx + 真实 pi/opencode 冒烟覆盖，Stage 1（单机 Adapter）、
   Stage 2（8 态状态机 + SQLite + 受理式 MCP）、Stage 3（远程 Worker Daemon）均已**实现并验证**。
   **Stage 5 并行调度**已落地核心：有界 FIFO 队列 + 单一 queue owner（`limits.maxQueuedTasks` 开启排队，
   `scheduler_status` 可观测），叠加此前的并发/输出/递归上限。余下重点是 **远程生产化补强**
   （开机启动、日志轮转、防火墙、真实双机 TLS 部署样例）与 **Stage 5 的进阶调度**（队列 TTL/截止时间、
   跨 profile 加权公平、DAG 依赖、重试、预算）。

---

## 1. 现状：已落地并验证（agentmesh）

代码位置：`D:\Programs\QoderCN\tmp\agentmesh`。验证环境：Windows / Node v26 / git 2.55。

| 能力 | 状态 | 位置 / 证据 |
|---|---|---|
| ACP Worker 驱动（acpx 进程内 runtime） | ✅ 完成，**已对真实 pi/opencode 跑通** | `src/drivers/acpxDriver.ts`、`scripts/real-smoke.ts` |
| Mock Worker（离线、确定性、零成本） | ✅ 完成（含 `requireApproval` 驱动 waiting） | `src/drivers/mockDriver.ts` |
| Orchestrator：spawn / dispatch / collect / kill | ✅ 完成 | `src/orchestrator.ts` |
| 8 态任务状态机 + 转移守卫 | ✅ 完成 | `src/statemachine.ts` |
| 异步任务生命周期（submit/wait/status/result/cancel/events） | ✅ 完成 | `src/tasks.ts` |
| SQLite 持久化（重启可查，node:sqlite） | ✅ 完成 | `src/store/sqlite.ts`、`test/tasks.test.ts` |
| 人工批准（权限 + elicitation → waiting） | ✅ 完成 | `src/approvals.ts` |
| Worker 注册表 + 事件环形缓冲 | ✅ 完成 | `src/registry.ts` |
| git worktree 并行隔离 | ✅ 完成 | `src/worktree.ts` |
| MCP Server（15 工具，stdio） | ✅ 完成 | `src/mcp/server.ts` |
| **远程 Worker Daemon（HTTP+WS）** | ✅ 完成，loopback 端到端验证 | `src/remote/*`、`test/remote.test.ts` |
| CLI：demo / list / mcp / dispatch / submit / tasks / approve / daemon | ✅ 完成 | `src/cli.ts` |
| 配置：YAML + zod 校验 | ✅ 完成 | `src/config.ts`、`agentmesh.yaml` |

**验证结果**：`tsc --noEmit` 干净通过；`npm test` **23/23**（orchestrator + tasks(9) + remote(8)）；
`npm run demo` 双场景闭环 `CLOSED ✅`；`npm run smoke` 真实 MCP stdio 全生命周期
（`accepted, started, output…, waiting, resumed, output…, completed`）；`scripts/real-smoke.ts`
对**真实 opencode + pi** 走 `submit → wait → result`，均 `succeeded`（2 任务 / 27 事件入库）。
远程侧：daemon CLI 启动自检 `/healthz` 开放、`/profiles` 无 token 401 / 带 token 200、干净退出。

---

## 2. v1.0 设想 ↔ MVP 现状 ↔ 决策

| v1.0 设想 | MVP 现状 | 决策 |
|---|---|---|
| 自研通用 ACP Client | 复用 acpx runtime | **采纳 acpx**，`adapter-acp` = acpx 封装 |
| 直接依赖第三方 `pi-acp`（nicobailon） | acpx 内置 `pi → npx pi-acp`（svkozak, v0.0.34） | 采纳；桥早期，保留 `PiRpcAdapter` 备用 |
| 8 态任务状态机（含 waiting/timed_out） | ✅ 已实现 8 态 | `src/statemachine.ts` + `src/tasks.ts` |
| SQLite 任务持久化、重启可查 | ✅ 已实现（node:sqlite） | `src/store/sqlite.ts` |
| 远程 Worker Daemon（HTTP/WebSocket） | ✅ 已实现（loopback 验证） | `src/remote/*`，作为一个 `WorkerDriver` |
| Adapter 受理语义 `startTask/getStatus/subscribe` | ✅ 受理式异步（task_submit/wait/status/result/events） | `src/tasks.ts` |
| MCP 工具 `agent_*/task_*` | ✅ 已合并为 15 工具 | `src/mcp/server.ts` |
| monorepo `apps/`+`packages/` | 单体 `src/`（remote/ 子模块边界清晰） | 暂缓拆包 |
| Worker 心跳/在线状态 | ✅ daemon 侧 ping/pong 心跳 | `src/remote/daemon.ts` |

---

## 3. 对齐后的总体架构

```
┌──────────────────────────────────────────────┐
│                 Master Agent                  │  ← 任意 MCP 客户端（opencode / pi / …）
│              OpenCode / Pi / Other            │     角色由“是否挂载本 MCP”决定，非类型决定
└──────────────────────┬───────────────────────┘
                       │ MCP tools (stdio)         【✅ 已实现】
                       ▼
┌──────────────────────────────────────────────┐
│              Orchestrator Service            │
│  MCP Server ✅   Task Scheduler ⏳(串行→并发) │
│  Agent Registry ✅  Session Manager ✅(acpx) │
│  State Machine ✅(8态)  Store ✅(SQLite)     │
│  Approvals ✅   Audit Log ⏳                 │
└──────────────┬──────────────────┬────────────┘
               │ Local (in-proc)   │ HTTP/WebSocket   【✅ 已实现】
               ▼                   ▼
┌────────────────────────┐  ┌────────────────────────┐
│ Local Agent Runtime    │  │ Remote Worker Daemon   │
│ = acpx runtime ✅      │  │ 认证/执行/监督/心跳 ✅ │
│ ACP over stdio         │  │ 本地再起 acpx/ACP      │
└────────────┬───────────┘  └────────────┬───────────┘
             │ stdio JSON-RPC            │ stdio JSON-RPC (本地)
             ▼                           ▼
     ┌──────────────┐            ┌──────────────────┐
     │ Agent Process│            │ Remote Agent     │
     │ pi/opencode  │            │ pi/opencode/…    │
     └──────────────┘            └──────────────────┘
```

图例：✅ 已实现 · ⏳ 待实现。**关键设计不变**：ACP stdio 从不跨网络暴露；远程由 Worker Daemon 在本机启动 ACP 子进程，
Orchestrator↔Daemon 走**带认证的 HTTP/WebSocket**（token 恒时比较 + 可选 TLS/mTLS + 工作目录白名单）。

---

## 4. 统一数据模型（合并 v1.0 §6 与 MVP types）

采用 v1.0 的模型作为**目标契约**；括号内为到 acpx/MVP 的映射。

```ts
export type AgentKind = "opencode" | "pi" | "other";

// 8 态状态机（v1.0），MVP 现为 {completed|cancelled|failed} 的子集
export type TaskStatus =
  | "queued" | "starting" | "running" | "waiting"
  | "succeeded" | "failed" | "cancelled" | "timed_out";
// 终态：succeeded | failed | cancelled | timed_out ；waiting 非终态

export interface AgentTask {
  taskId: string;
  prompt: string;
  workingDirectory: string;   // 必须命中白名单
  timeoutMs: number;
  sessionId?: string;         // ↔ acpx sessionKey（复用会话）
  idempotencyKey?: string;    // 防重放（不幂等任务禁止盲目重试）
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  taskId: string;
  status: TaskStatus;
  text?: string;              // ↔ acpx turn 收集的 text_delta(stream!="thought")
  sessionId?: string;
  error?: { code: string; message: string; retryable: boolean };
  artifacts?: Array<{ type: "file" | "diff" | "log"; path?: string; description?: string }>;
}

export interface AgentEvent {
  eventId: string; taskId: string; agentId: string;
  sequence: number; timestamp: string;
  type: "accepted" | "started" | "output" | "waiting" | "completed" | "failed" | "cancelled";
  data?: Record<string, unknown>;
}

// 受理式 Adapter（v1.0）。MVP 的 WorkerHandle.runTurn 是其同步特例，
// 演进：startTask 立即返回受理；事件经 subscribe 流式；结果经 getResult 拉取。
export interface AgentAdapter {
  readonly kind: AgentKind;
  healthCheck(): Promise<boolean>;
  startTask(task: AgentTask): Promise<{ accepted: boolean }>;
  getStatus(taskId: string): Promise<TaskStatus>;
  getResult(taskId: string): Promise<AgentResult | undefined>;
  cancelTask(taskId: string): Promise<void>;   // 只有确认底层终止后才置 cancelled
  subscribe(taskId: string, handler: (e: AgentEvent) => void): Promise<() => void>;
  close(): Promise<void>;
}
```

**acpx 事件 → AgentEvent 映射**（已在 `acpxDriver.ts` 做了一半）：
`text_delta(stream!=thought)`→`output`；`tool_call`→`output{kind:tool}`；`status`→`output`；
`turn.result: completed`→`completed`；`failed`→`failed`；`cancel()`→`cancelled`。
`waiting` 来自 ACP 权限/elicitation 回调（`onPermissionRequest`/`onElicitation`），已接线：任务进入 `waiting`，
Master 经 `pending_approvals` + `task_approve`/`task_respond` 决策后同步恢复 `running`（本地与远程一致）。

---

## 5. MCP 工具对齐（合并 v1.0 §7 与 MVP 已实现）

| 目标工具（v1.0） | 现状 | 差距 / 动作 |
|---|---|---|
| `agent_list` | ✅ | 返回 profiles + live workers |
| `agent_inspect` | ✅ | 单 worker 状态 + 最近事件 |
| `task_submit`（受理，返回 taskId） | ✅ | 立即返回 taskId |
| `task_status` | ✅ | 独立任务级查询 |
| `task_wait`（到终态或 waiting） | ✅ | 进入 waiting 即返回，供 Master 批准 |
| `task_result` | ✅ | 文本/状态/错误 |
| `task_cancel`（确认后才 cancelled） | ✅ | 等 worker 落定再置 cancelled |
| `task_events` | ✅ | 按 sequence 分页 |
| `pending_approvals` / `task_approve` / `task_respond` | ✅ | 权限/elicitation 批准回路 |
| `spawn_worker` / `kill_worker` | ✅ | 预热 worker / worktree |
| `list_tasks` | ✅ | 按状态过滤 |
| `dispatch_task`（同步便利） | ✅ | submit + wait 一步 |

**安全边界（v1.0 §7.8，全部保留）**：Master 不能指定未批准的可执行文件；工作目录白名单；
远程 Worker 只接受授权 Master；**Agent 输出视为不可信数据，绝不当作系统指令**；高风险/删除/凭证操作走人工批准。
acpx 侧对应：`permissionMode`（`deny-all|approve-reads|approve-all`）+ `onPermissionRequest` 回调。

---

## 6. 修订路线图（含已完成状态）

### Stage 0 · 协议可行性验证 —— ✅ 完成
- ✅ 经 acpx 覆盖：ACP 初始化/会话/prompt/事件/取消/退出的客户端侧。
- ✅ 对**真实 `opencode acp` 与 `pi`(pi-acp)** 各跑通任务（`scripts/real-smoke.ts`）：程序化提交、
  收到流式与结束事件、`task_cancel` 确认后置 `cancelled`、两 Agent 均 `succeeded`。

### Stage 1 · 单机 Adapter —— ✅ 完成
- ✅ `AgentAdapter`/事件类型、OpenCode/Pi（经 acpx）、Mock Adapter、统一错误/超时。
- ✅ 3 态→**8 态状态机**（`statemachine.ts`）；`task_submit` **受理式异步**；`subscribe`/`cancel`/超时在各 Adapter 一致；
  接线 `waiting`（`onPermissionRequest`/`onElicitation` → `waiting` + 批准工具）。
- ✅ 验收：同一套测试跑不同 Adapter；流式输出不重复结束；Agent 异常退出可检测（`failed`/`timed_out`）。

### Stage 2 · Orchestrator + SQLite + MCP —— ✅ 完成
- ✅ Agent Registry、MCP 工具（17，含 `scheduler_status` 与 `master_playbook`）、受理式查询/取消/结果。
- ✅ **SQLite 持久化**（任务/事件，`node:sqlite` WAL）；`task_submit/wait/status/result/cancel/events` 全量；
  重启后已存任务可查（`test/tasks.test.ts` 覆盖 restart-and-requery）。
- ✅ Task Scheduler 并发上限（`limits.maxConcurrentTasks`）+ 有界 FIFO 队列（`limits.maxQueuedTasks`，见 Stage 5）；
  结构化审计日志已在远程 daemon 控制平面落地（NDJSON，见 Stage 3）。
- ✅ 验收：Master 经 MCP 调 Worker；可查状态取结果；**服务重启后任务仍可查询**。

### Stage 3 · 远程 Worker —— ✅ 已实现（loopback 验证）
- ✅ Worker Daemon：HTTP(`/healthz`,`/profiles`) + WS(`/ws`) 协议、token 认证（恒时比较）、远程本机起 acpx/ACP、
  断线时**取消在跑任务**（不产生孤儿）、ping/pong 心跳、事件按 sequence 转发去重。
- ✅ Remote 作为一个 `WorkerDriver`（`src/remote/client.ts`），Orchestrator/TaskManager/审批链路**零改动复用**；
  客户端把转发的 task 事件重建为 WorkerEvent，`waiting` 经 `onPermissionRequest`/`onElicitation` 回到 Master。
- ✅ 安全层：token 从环境变量读（**不入配置/版本库**）、工作目录白名单（段前缀匹配，挡 `../` 与 `/srv/repos_evil`）、
  非 loopback 绑定强制 TLS（否则需显式 `--allow-insecure`）、可选 mTLS。
- ✅ Windows：路径规范化、子进程 stdio、SIGINT/SIGTERM 优雅退出、残留清理（socket 断开即 cancel）。
- ✅ **状态对账**：协议新增 `query`/`query_result`；客户端 `queryRemoteTask(remote, taskId)` 一次性重连查询
  权威持久化记录（`RemoteWorkerDriver.queryTask` 同）。断线时在跑任务被 daemon 取消，重连查询得到权威
  `cancelled` 而非误判 `succeeded`；未知 id 返回 `undefined`。
- ✅ **推送式续订**：协议新增 `attach`/`attached`；daemon 增加 `orphanGraceMs` 宽限窗（默认 0=立即取消，保持无孤儿）、
  `taskOwner` 事件路由表与 `orphanTimers`。`handleAttach` 同步完成「校验任务→按 `afterSequence` 重放持久化事件→
  移交 owner 续订实时事件→终态发 result」，无 await 故重放快照与实时流之间无缝无重。客户端
  `attachRemoteTask(remote, taskId, {afterSequence,onEvent,onPermissionRequest,onElicitation,signal})`
  在宽限窗内恢复在跑任务而非重跑；signal 中止只脱离不取消。
- ✅ **透明自动重连**：`remote.resume` 开启时 `runTurn` 掉线自动按 `reconnectAttempts`/`reconnectDelayMs`
  重连并 `attach(afterSequence=lastSeq)` 续流，陈旧 socket 事件用 `stale()` 守卫忽略、task_event 按 sequence 去重，
  Master 无感知；未拿到 taskId（submit 前失败，如坏 token）不重连、直接失败，避免非幂等重放。
- ✅ **密钥轮换**：`tokenEnv` 可逗号分隔多个环境变量名，每个变量的值也可逗号分隔多个 token，daemon 同时接受新旧密钥；
  `anyTokenEqual` 恒时逐一比较（不短路，不泄露命中位置/数量）；`reloadTokens()` 从环境重读实现零停机热轮换，
  CLI 监听 `SIGHUP` 触发，轮换到空集会被拒绝以免 daemon 变无认证或自锁。密钥值仅存环境，配置只写变量名。
- ✅ **结构化审计日志**：`src/remote/audit.ts` 追加 NDJSON 控制平面审计（`daemon.auditPath`，默认 `<workdir>/daemon-audit.ndjson`，
  置空串关闭）。记录 auth 成败（含 peer）、连接开合、submit 及白名单/profile 裁决、approve/respond/cancel、attach、
  orphan、token reload、daemon 启停。**密钥绝不落盘**——仅记 12 位十六进制不可逆指纹；不可信的 task/agent 文本一律不记。
  缓冲异步写，坏 token 洪泛不会阻塞事件循环；写盘错误吞掉不影响请求路径。
- ⏳ 生产化补强：开机启动/日志轮转、防火墙与真实双机 TLS 部署样例（当前为 loopback 验证形态）。
- ✅ 验收（`test/remote.test.ts`，18 例）：A 侧 `RemoteWorkerDriver` 调 B 侧 daemon 的 mock worker；
  输出/结果/流式事件回到 A；approval 往返；cancel；**坏 token 拒绝**；**白名单外 cwd 拒绝**；
  `/healthz` 免认证 vs `/profiles` 需认证；**完成后重连对账**、**未知 id→undefined**、**断线在跑→cancelled 不误判成功**；
  **attach 在宽限窗内重放到 succeeded（序列严格递增）**、**afterSequence 只重放更新事件**、**attach 未知任务拒绝**、
  **runTurn 掉线透明重连后仍 completed**；**多 token 并存（HTTP+WS 升级均接受、未签发 token 拒绝）**、
  **reloadTokens() 热轮换生效且拒绝空集**；**审计 NDJSON 记录 auth/submit/裁决且 token 明文绝不出现**；
  `assertSafeBind`/`assertCwdAllowed` 单测。daemon CLI 启动自检通过。

### Stage 4 · 双向角色 + 第二种 Worker —— 🟡 概念已验证
- ✅ demo 已证明“角色对称、由配置决定”（同一 Orchestrator，master 只是挂 MCP 的一方）。
- ⏳ 用**真实** Agent 跑通四组合：OpenCode→Pi、OpenCode→OpenCode、Pi→OpenCode、Pi→Pi，端到端自动化测试。

### Stage 5 · 并行与代码工作流 —— 🟡 核心已落地
- ✅ **并发限制 + 有界 FIFO 调度**：`limits.maxConcurrentTasks` 限在跑任务数；`limits.maxQueuedTasks`
  （默认 0 = 超限即拒 `concurrency_limit_exceeded`，向后兼容）>0 时开启真正排队——超限 submit 进 FIFO 队列，
  随在跑任务结算由单一 queue owner（`pump()`）自动出队；队列也满才拒（`queue_full`）。排队任务不占 worker，
  可即时取消（不等 cancel 宽限）。`scheduler_status` MCP 工具暴露 running/queued 计数、上限与队列顺序。
- ✅ 独立 git worktree（代码已备）；失败/超时/取消路径均有测试（`test/tasks.test.ts` 的调度四例：
  排队并 FIFO 出队、队满拒绝、取消排队任务即时结算、并发扇出受 `maxConcurrentTasks` 约束）。
- ⏳ DAG 依赖、可配置重试、跨 profile 加权公平、队列 TTL/截止时间、人工审批预算、可选 Web 控制台。
- 验收：多任务并发；同一工作目录不被多个写任务无保护同时改；失败/超时/取消路径均有测试。

---

## 7. 安全与可靠性（v1.0 §13 全保留 + 补充）

远程认证 + TLS/可信通道；不向局域网暴露未保护的 ACP stdio 桥；工作目录白名单；命令/工具权限最小化；
密钥从环境变量或安全凭证存储读取（**不入配置文件/版本库**）；结构化审计日志；超时/最大并发/输出大小限制
（✅ `limits.maxConcurrentTasks` + 有界 FIFO 队列 `maxQueuedTasks` + `maxOutputBytes` 已落地）；
**防无限递归委派**（Master 也是 Agent，需深度/预算上限；✅ 深度上限已落地，预算上限待 Stage 5 进阶）；
Agent 输出视为不可信；不可逆操作人工确认；记录 Agent/Adapter/协议版本。

**落地状态**：远程认证/TLS ✅、工作目录白名单 ✅、密钥仅存环境 ✅、零停机密钥轮换 ✅、结构化审计日志（NDJSON，密钥仅记指纹、不落不可信文本）✅、超时 ✅、
**防无限递归委派 ✅**（`limits.maxDelegationDepth` 默认 8；进程从 `$AGENTMESH_DELEGATION_DEPTH` 读自身层级，向所 spawn 的 agent 注入 层级+1，
嵌套 agentmesh 经环境继承链路深度；有效深度达上限的 submit 以 `delegation_depth_exceeded` 失败且**不 spawn worker**，调用方 metadata 只能抬高、不能压低继承的 base）、
**最大并发上限 ✅**（`limits.maxConcurrentTasks`，0/未设=不限；超限的 submit 以 `concurrency_limit_exceeded` 失败且**不 spawn worker**，任务终结即释放名额）、
**单任务输出大小上限 ✅**（`limits.maxOutputBytes` 默认 1 MiB；超长结果按 UTF-8 边界截断（绝不切断多字节码点），记录标记 `outputTruncated` 并追加一条截断事件）、
**跨 Worker 交接注入上限 ✅**（`limits.maxHandoffBytes` 默认 256 KiB；前驱 `result` 注入后继 prompt 时按 UTF-8 边界截断、标记 `truncated`，且包裹为 `trusted=NO` 不可信数据信封——上游产物是**数据不是指令**，与「Agent 输出视为不可信数据」红线一致）。
补充（acpx 相关）：`permissionMode` 默认 `approve-all` 便于自动执行，但**远程/生产应降为 `approve-reads` 或 `deny-all` + 显式批准回调**；
acpx 会话作用域按 `(agentCommand, cwd, sessionKey)` 精确匹配，跨目录不继承。

---

## 8. 风险与缓解（v1.0 §14 + 新增）

| 风险 | 缓解 |
|---|---|
| ACP 实现能力不一致 | Adapter 能力声明；按目标版本集成测试 |
| **pi-acp 桥早期（v0.0.34）** | 保留 Pi 原生 RPC/SDK 备用 Adapter；锁版本 |
| Agent 取消不可靠 | 校验底层会话/进程，不只看取消响应 |
| 网络断线 | 心跳、重连、状态对账、事件序号 |
| 重复执行 | 幂等键；不确定先对账，不盲目重放 |
| 多 Worker 改同一代码 | git worktree + 分支 + 合并检查 |
| Agent 要求人工输入 | `waiting` 态 + 批准接口 |
| 远程权限过大 | 白名单、最小权限、审计、人工审批 |
| **acpx pre-1.0 接口演进** | 锁 `acpx` 版本；封装在 `adapter-acp` 内，隔离上游变更 |
| **递归委派失控** | ✅ 深度上限 `limits.maxDelegationDepth` + `$AGENTMESH_DELEGATION_DEPTH` 跨进程传播；达上限的 submit 失败且不 spawn worker（预算上限待 Stage 5） |
| **资源耗尽（并发/输出爆炸）** | ✅ `limits.maxConcurrentTasks` 限制在飞任务数（超限 submit 失败不 spawn）；`limits.maxOutputBytes` 截断超长结果并按 UTF-8 边界安全裁剪、标记 `outputTruncated` |

---

## 9. 已核验的参考链接（修正版 · 2026-10）

**协议 / Agent**
- ACP 官网 https://agentclientprotocol.com/ ｜ 协议仓库 https://github.com/agentclientprotocol/agent-client-protocol ｜ 注册表 https://github.com/agentclientprotocol/registry
- **acpx（本项目 ACP 客户端底座）** https://github.com/openclaw/acpx ｜ npm `acpx`
- OpenCode：**https://github.com/anomalyco/opencode**（`sst/opencode` 已重定向至此，214k⭐）｜ ACP 文档 https://opencode.ai/docs/acp/ ｜ npm `opencode-ai`
- Pi：**https://github.com/earendil-works/pi**（原 `badlogic/pi-mono` 已 404，115k⭐）｜ 文档 https://pi-doc.com/docs/latest/ ｜ npm `@earendil-works/pi-coding-agent`
- Pi ACP 桥：**https://github.com/svkozak/pi-acp**（原 `nicobailon/pi-acp` 已 404）｜ npm `pi-acp@0.0.34`（acpx 内置 `pi` 即 `npx pi-acp`）

**Master 工具接入**
- MCP https://modelcontextprotocol.io/ ｜ TS SDK https://github.com/modelcontextprotocol/typescript-sdk

**可参考的编排项目（仅借鉴，需核验许可证/源码）**
- https://github.com/asheshgoplani/agent-deck （1k⭐, Go, 终端会话管理器）
- https://github.com/awslabs/cli-agent-orchestrator （tmux supervisor, Python）
- https://github.com/OrchestratorInc/agent-orchestrator （13k⭐, Go+Electron, 重型 GUI）
- https://github.com/fveracoechea/agent-loop （1⭐, 谨慎参考）
- 生态榜单 https://github.com/RyanAlberts/best-of-Agent-Harnesses

---

## 10. 立即可做的下一步（建议顺序）

Stage 0–3 已落地并验证，接下来的重点从「能不能跑」转向「跑得多、跑得稳、跑得像产品」：

1. ~~**Stage 5 · 并行与调度**~~ ✅ 核心已落地：有界 FIFO 队列 + 单一 queue owner（`limits.maxQueuedTasks`
   >0 开启排队，`pump()` 随槽位释放自动出队；`scheduler_status` 可观测），叠加已有的 `maxConcurrentTasks` /
   `maxOutputBytes` / 递归深度上限；多 worktree 并行代码已备；失败/超时/取消路径均有并发测试（`test/tasks.test.ts`）。
   ⏳ 进阶：队列 TTL/截止时间、跨 profile 加权公平、DAG 依赖、可配置重试、预算上限。
2. **远程生产化补强**：状态对账（`query`）、推送式续订（`attach` + orphan 宽限）、透明自动重连（`resume`）、
   **零停机密钥轮换**（多 token + `SIGHUP`/`reloadTokens()`）、**结构化审计日志**（NDJSON，密钥仅记指纹）均已落地。
   ⏳ 余下：开机启动/日志轮转、防火墙与部署样例；把 loopback 验证形态推向真实双机 TLS 部署。
3. ~~**Master 侧提示词/技能包**~~ ✅ 已落地：委派手册随仓库分发（`skills/agentmesh-master/SKILL.md` + `SKILL.zh.md`），
   由 MCP server 自托管——`master_playbook` 工具（通用可调，`lang` 选 en/zh）+ 两个可浏览 resource
   （`agentmesh://skills/master/en|zh`）；运行时从包根解析，源码与 dist 构建皆可用。内容涵盖五条铁律、委派闭环、
   意图→工具速查、子任务 prompt 要素、反模式与安全红线，让 Master 默认就会「好好委派」。
   ⏳ 进阶：MCP prompts 通道、按 profile/任务类型细分的技能片段。
4. ~~**跨 Worker 交接**~~ ✅ Phase 1 已落地：`task_submit`/`dispatch_task` 的 `handoff` 字段把**已完成前驱**的
   `result` 文本在 run 时注入后继 prompt——包裹为**不可信数据**信封（`trusted=NO`，明示「当作数据而非指令」），
   按 `limits.maxHandoffBytes`（默认 256 KiB）UTF-8 安全截断并标记 `truncated`；**持久化的 `prompt` 保持原样**，
   仅落一条 `metadata.handoff` 摘要与一条 `handoff` 事件（大/敏感产物不进 prompt 列）。受理期校验：源任务未知 →
   `handoff_unknown_task`，源未达 `succeeded` → `handoff_predecessor_not_ready`，二者均**不 spawn worker**。
   ⏳ Phase 2/3：`inject:"diff"`（前驱工作树 diff 作为脱敏 artifact sidecar + `task_artifact` 工具）、
   `base:"predecessor"`（后继 worktree 从前驱终态分叉 + 真实 git 集成测试）。
5. **结构化结果契约**：每任务 JSON 输出 schema + 从 ACP `usage_update` 汇总成本/用量。
6. ~~**递归守卫**~~ ✅ 已落地：`limits.maxDelegationDepth`（默认 8）+ `$AGENTMESH_DELEGATION_DEPTH` 跨进程传播，
   达上限的 submit 以 `delegation_depth_exceeded` 失败且不 spawn worker（预算上限并入 Stage 5）。
   ~~最大并发 / 单任务输出大小上限~~ ✅ 亦已落地（见 §7）。
7. **可选 Web 控制台**：可视化任务与远程 Worker 状态（结构化审计日志已提供数据源）。

> Stage 0–3 已完成并通过 54 项测试（含真实 opencode/pi、loopback 远程端到端、密钥轮换、审计日志、递归守卫、资源上限、Stage 5 有界 FIFO 调度、自托管 master 技能与跨 Worker 交接 Phase 1）。
> 下一步优先远程真实双机 TLS 部署与 Stage 5 进阶调度（队列 TTL、加权公平、DAG 依赖）。
