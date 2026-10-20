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
   **Stage 5 并行调度**已落地核心：有界队列 + 单一 queue owner（`limits.maxQueuedTasks` 开启排队，
   `scheduler_status` 可观测），队列 TTL 与截止时间（`limits.queueTtlMs`、`task_submit{deadlineMs|deadlineAt}`）、
   跨 profile 加权公平（profile `weight`，WFQ finish tag）亦已实现并测试；叠加此前的并发/输出/递归上限。
   余下重点是 **Stage 5 的进阶调度**（DAG 依赖 ✅、重试 ✅、审批/成本预算 ✅）与
   **可选 Web 控制台**；**远程生产化补强**（开机启动、日志轮转、防火墙、双机 TLS 手册）已落地。

---

## 1. 现状：已落地并验证（agentmesh）

代码位置：`D:\projects\agentmesh`。验证环境：Windows / Node v22.22 / git 2.55。

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
| MCP Server（18 工具，stdio） | ✅ 完成 | `src/mcp/server.ts` |
| **远程 Worker Daemon（HTTP+WS）** | ✅ 完成，loopback 端到端 + 真实网卡 TLS/mTLS 验证 | `src/remote/*`、`test/remote.test.ts`、`test/deploy.test.ts` |
| CLI：demo / list / mcp / dispatch / submit / tasks / approve / daemon | ✅ 完成 | `src/cli.ts` |
| 配置：YAML + zod 校验 | ✅ 完成 | `src/config.ts`、`agentmesh.yaml` |

**验证结果**：`tsc --noEmit` 干净通过；`npm test` **163/163**（tasks(32) + handoff(12) + artifact(7) +
paths(3) + contract(10) + dag(18) + budget(11) + remote(26) + deploy(8) + orchestrator(11) + skill(4) + team(21)）；
（远程 daemon 支持**会话复用**：同一 `workerId` 连续 `task_submit` 复用 B 侧 agent 会话，
`daemon.workerIdleMs` 兜底回收；**固定会话**：profile 配 `session` 或提交带 `sessionKey`，
会话落盘、daemon 重启后同 key 恢复——已用真实 pi 验证：停 daemon 再用同 key 提交，
pi 仍记得上一「辈子」之前被告知的数字，ACP 会话 id 前后一致。）
`npm run demo` 双场景闭环 `CLOSED ✅`；`npm run smoke` 真实 MCP stdio 全生命周期
（`accepted, started, output…, waiting, resumed, output…, completed`）；`npm run real`
对**真实 opencode + pi** 走 `submit → wait → result`，均 `succeeded`（2 任务 / 27 事件入库）。
远程侧：daemon CLI 启动自检 `/healthz` 开放、`/profiles` 无 token 401 / 带 token 200、干净退出；
`npm run deploy:tls` 在本机 LAN 地址（非 loopback）上跑通 9/9 检查——明文绑定被拒、
真实证书链上任务完成、daemon 观测到对端来自该地址、错误 CA 被拒、mTLS 缺证书被拒 / 带证书完成。

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
| MCP 工具 `agent_*/task_*` | ✅ 已合并为 18 工具 | `src/mcp/server.ts` |
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
- ✅ **队列 TTL + 每任务截止时间**：`limits.queueTtlMs` 限制排队最长等待，到期出队并结算 `timed_out`
  （`queue_ttl_exceeded`），**不 spawn worker**；`task_submit{deadlineMs|deadlineAt}` 覆盖「排队 + 执行」全程，
  命中即 `timed_out`（`deadline_exceeded`）——无论在排队还是在跑；submit 时已过期的 deadline 直接拒绝。
  运行期定时器取 `min(timeoutMs, 截止剩余)`，两种预算叠加而非互斥。
- ✅ **跨 profile 加权公平**：profile `weight`（默认 1 = 严格 FIFO，保持向后兼容）。任一处设非 1 权重即启用
  WFQ finish tag（`tag = max(pass[profile], virtualTime) + 1/weight`），高权重 profile 在争用时按比例拿到更多
  出队名额；虚拟时间按**服务量**推进，后到任务无法用陈旧 tag 插队。权重只影响排队顺序，不突破并发上限。
  `scheduler_status` 现额外暴露 `fairness`、`queueTtlMs` 与每项的 `weight` / `waitedMs` / `expiresInMs`。
- ✅ 独立 git worktree（代码已备）；失败/超时/取消路径均有测试（`test/tasks.test.ts` 的调度用例：
  排队并 FIFO 出队、队满拒绝、取消排队任务即时结算、并发扇出受 `maxConcurrentTasks` 约束、队列 TTL 过期、
  排队/运行两种 deadline 命中、默认权重保序 + `weight: 3` 抢占前 4 个名额中的 3 个）。
- ✅ DAG **依赖与重试已落地**（见下），审批预算（`limits.maxWaitingTasks`）与花费预算（任务级 `budget`、进程级 `maxTotalTokens`/`maxTotalCost`）亦已落地；余下为可选 Web 控制台。
  - ✅ **DAG 依赖**：`task_submit`/`dispatch_task` 的 `dependsOn`（受理期校验：未知任务 `dependency_unknown_task`、
    已失败/取消/超时的前置 `dependency_failed`、超过 `limits.maxDependencies` 的 `dependency_limit_exceeded`、
    未开队列的 `dependency_requires_queue`）。被门控任务以 `queued` + `blockedBy` 受理，**不进派发队列**
    （不占并发槽、不干扰 FIFO/加权顺序），最后一个依赖成功的瞬间入队；依赖非成功结算则以 `dependency_failed`
    失败**且不 spawn worker**，并沿链级联（每个下游都失败而不是永久卡住）；取消时 `blockedBy` 一并清理。
    被门控任务计入 `maxQueuedTasks`（它是"已受理、等调度"的工作），因此不会出现无界积压；队列 TTL 从**就绪**起算，
    截止时间仍覆盖全程（阻塞期间只挂截止计时器）。依赖关系在受理时冻结且只能指向已存在任务 ⇒ 结构上无法成环。
  - ✅ **可配置重试**：`retry: { maxAttempts, delayMs, backoff: fixed|exponential, maxDelayMs, onlyRetryable }`，
    由 `limits.maxRetryAttempts`（默认 5）钳制。**只在真正跑过的尝试**失败/超时后重试（受理期拒绝不算，
    重放只会同样失败），`cancelled` 永不重试，`queue_ttl_exceeded` 也不重试（同一条拥堵队列没有意义），
    截止时间已过则不重试。重试在 `setState` 写入终态**之前**拦截，记录因此从不落到终态 ⇒ `task_wait` 跨越多轮、
    依赖者继续等待；每轮换新的 `AbortController`（上一轮超时已 abort）与新 worker/worktree；失败轮归档进
    `metadata.attempts`（状态/错误/耗时/花费/有界文本预览）；token 与成本**跨尝试累加**（每轮都真的花了）。
    退避期间任务不占队列槽，只挂截止计时器；`cancel` 立即清掉退避计时器并结算。
    验收：`test/dag.test.ts` 17 例（阻塞后放行、失败级联、取消级联、阻塞期可取消、无队列拒绝、三类受理期拒绝、
    容量计入、阻塞期截止、重试耗尽、瞬时失败恢复、退避时序、跨尝试用量累加、受理拒绝不重试 + `onlyRetryable`、
    退避中取消、退避期截止、`maxRetryAttempts` 钳制、SQLite 往返）。
- 验收：多任务并发；同一工作目录不被多个写任务无保护同时改；失败/超时/取消路径均有测试。

---

## 7. 安全与可靠性（v1.0 §13 全保留 + 补充）

远程认证 + TLS/可信通道；不向局域网暴露未保护的 ACP stdio 桥；工作目录白名单；命令/工具权限最小化；
密钥从环境变量或安全凭证存储读取（**不入配置文件/版本库**）；结构化审计日志；超时/最大并发/输出大小限制
（✅ `limits.maxConcurrentTasks` + 有界 FIFO 队列 `maxQueuedTasks` + `maxOutputBytes` 已落地）；
**防无限递归委派**（Master 也是 Agent，需深度/预算上限；✅ 深度上限与花费/审批预算均已落地）；
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
| **递归委派失控** | ✅ 深度上限 `limits.maxDelegationDepth` + `$AGENTMESH_DELEGATION_DEPTH` 跨进程传播；达上限的 submit 失败且不 spawn worker。宽度与金额另由 `limits.maxWaitingTasks`、任务级 `budget`、进程级 `maxTotalTokens`/`maxTotalCost` 约束 |
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

1. ~~**Stage 5 · 并行与调度**~~ ✅ 核心已落地：有界队列 + 单一 queue owner（`limits.maxQueuedTasks`
   >0 开启排队，`pump()` 随槽位释放自动出队；`scheduler_status` 可观测），叠加已有的 `maxConcurrentTasks` /
   `maxOutputBytes` / 递归深度上限；队列 TTL（`queueTtlMs`）、每任务截止时间（`deadlineMs`/`deadlineAt`）、
   跨 profile 加权公平（`weight` + WFQ finish tag）亦已落地并测试；多 worktree 并行代码已备；失败/超时/取消路径
   均有并发测试（`test/tasks.test.ts`）。
   ✅ 进阶：审批/成本预算已落地（见 §10），可选 Web 控制台待做。（DAG 依赖与可配置重试已完成。）
2. **远程生产化补强**：状态对账（`query`）、推送式续订（`attach` + orphan 宽限）、透明自动重连（`resume`）、
   **零停机密钥轮换**（多 token + `SIGHUP`/`reloadTokens()`）、**结构化审计日志**（NDJSON，密钥仅记指纹）均已落地。
   ✅ 后续补强已完成：**可选双向 TLS**（配置 `daemon.tls.ca` 即强制客户端证书，握手拒绝记 `tls_reject`）、
   证书/密钥/CA 支持「路径或内联 PEM」并在启动时报 `tls_invalid`（此前文档写了路径、客户端却把路径当 PEM 传给 `ws`，
   照文档双机部署必然握手失败）、**按大小轮转的审计日志**（`auditMaxBytes`/`auditKeep`，轮转期间记录缓冲不丢）、
   **开机启动**（systemd 单元 + Windows 计划任务入口）、**防火墙规则**，以及 `docs/deploy.md` 的双机手册。
   验证形态从 loopback 推进到**本机真实网卡**：`npm run deploy:tls` 用现生成的 CA 在 `0.0.0.0` 上起 TLS daemon，
   master 走 `https://<LAN IP>:<port>`，9/9 检查通过（含错误 CA、mTLS 缺证书/带证书、明文绑定被拒），
   并断言 daemon 审计里对端地址就是该网卡地址。⚠️ 仍未有跨物理链路的实跑（DNS/路由/防火墙尚未真实穿越）。
3. ~~**Master 侧提示词/技能包**~~ ✅ 已落地：委派手册随仓库分发（`skills/agentmesh-master/SKILL.md` + `SKILL.zh.md`），
   由 MCP server 自托管——`master_playbook` 工具（通用可调，`lang` 选 en/zh）+ 两个可浏览 resource
   （`agentmesh://skills/master/en|zh`）；运行时从包根解析，源码与 dist 构建皆可用。内容涵盖五条铁律、委派闭环、
   意图→工具速查、子任务 prompt 要素、反模式与安全红线，让 Master 默认就会「好好委派」。
   ⏳ 进阶：MCP prompts 通道、按 profile/任务类型细分的技能片段。
4. ~~**跨 Worker 交接**~~ ✅ Phase 1–3 全部落地：`task_submit`/`dispatch_task` 的 `handoff` 字段把**已完成前驱**的
   `result` 文本在 run 时注入后继 prompt——包裹为**不可信数据**信封（`trusted=NO`，明示「当作数据而非指令」），
   按 `limits.maxHandoffBytes`（默认 256 KiB）UTF-8 安全截断并标记 `truncated`；**持久化的 `prompt` 保持原样**，
   仅落一条 `metadata.handoff` 摘要与一条 `handoff` 事件（大/敏感产物不进 prompt 列）。受理期校验：源任务未知 →
   `handoff_unknown_task`，源未达 `succeeded` → `handoff_predecessor_not_ready`，二者均**不 spawn worker**。
   - ✅ Phase 2 `inject:"diff"`：捕获前驱工作树差异（含 untracked，遵守 `.gitignore`，用**临时 index** 不扰动前驱），
     正则脱敏（AWS/GitHub/OpenAI/Slack token、Bearer、PEM 私钥、`password=` 赋值）后写入
     `<workdir>/handoffs/<taskId>.diff`，prompt 只给路径——大 patch 不进 prompt。脱敏定位为「减少意外泄漏的兜底」，
     不宣称能保证无密钥；artifact 仍是不可信数据。
     *偏差说明*：原计划配一个 `task_artifact` MCP 工具，实测 `task_result` 已返回
     `metadata.handoff.artifact` / `filesChanged` / `redactions`，单开工具是冗余 surface，故未加。
   - ✅ Phase 3 `base:"predecessor"`：用 `git write-tree` + `commit-tree`（临时 index，不改前驱 HEAD/工作区）把前驱末态
     打成 commit，后继 worktree 从该 commit 分叉，直接继承未提交改动；无 worktree 时受理期拒
     `handoff_base_requires_worktree`，前驱工作树已消失/跨仓拒 `handoff_base_unavailable`。
   - ✅ Phase 4 跨机 diff 交接：`inject:"diff"` 对 `driver: remote` 后继不再拒绝——补丁字节随 `submit` 过网
     （协议 v2：`artifacts:[{name,data(base64),sha256}]`，单件上限 4 MiB，超出受理期拒 `handoff_artifact_too_large`），
     daemon 先校验「裸 `*.diff` 文件名 + base64 解码后大小 + SHA-256」再把文件写进**自己的** `<workdir>/handoffs/`
     （0600，绝不写进白名单仓库、绝不按调用方给的路径写），随后把 prompt 里的 `{{artifact:N}}` 重写成该绝对路径——
     master 无从得知对面路径，所以不猜。校验失败以 `artifact_invalid` / `artifact_too_large` /
     `artifact_checksum_mismatch` 拒收且不落盘，审计记 `submit_rejected{reason:artifact_rejected}`。
   - ⏳ 远程后继的 `base:"predecessor"` 仍拒 `handoff_artifact_unavailable`：commit 只在 master 的对象库里可达，
     不是可传输的字节；`git bundle` 只在两侧共享同一 base 时才有定义，故不做。
5. ~~**结构化结果契约**~~ ✅ 已落地：`task_submit`/`dispatch_task` 的 `outputSchema`（JSON Schema，draft-07 语义，
   经 ajv 校验）在 run 时作为 `OUTPUT CONTRACT (enforced)` 区块追加到提示词末尾（瞬态，不落库），结束后解析
   （整段 → 代码围栏 → 首个平衡 `{…}`/`[…]`）并校验：解析不出 → `output_not_json`，违反 schema →
   `output_schema_invalid`（最多 10 条错误带 JSON 路径，进 `metadata.outputContract.errors`），二者都**失败任务但保留原文**
   且标 `retryable`；schema 序列化 >16 KiB 在受理期以 `output_schema_too_large` 拒绝（它是提示词负载）。
   成功时解析值落 `structured` 列，`task_result` 直接返回。
   ~~成本/用量汇总~~ ✅ 已落地：ACP `usage_update` 在驱动层映射为 `usage` worker 事件；任务层**以最新上报覆盖**而非累加
   （ACP 报的是会话当前状态：token 是按回合总量、cost 是累计值），token 落 `usage` 列并即时持久化（超时/取消也留痕）；
   **成本按增量归属**——回合开始时记住该 worker 的累计 cost 基线，只把差值算给本任务，复用 worker 不会重复计费；
   计数器倒退视为适配器重启，按本回合独立数字处理。`usage_summary` 跨任务聚合（`profile`/`since` 过滤），
   **成本按币种分组、绝不跨币种相加**。
   - 偏差说明：schema 本身不落库（只存 `structured` 与 `outputContract` 判定）——它是提交者的输入，重放时由调用方提供；
     避免每条任务记录被 16 KiB schema 撑大。`$schema` 声明其他草案时被忽略而非报错。
6. ~~**递归守卫**~~ ✅ 已落地：`limits.maxDelegationDepth`（默认 8）+ `$AGENTMESH_DELEGATION_DEPTH` 跨进程传播，
   达上限的 submit 以 `delegation_depth_exceeded` 失败且不 spawn worker（花费/审批预算见 §10）。
   ~~最大并发 / 单任务输出大小上限~~ ✅ 亦已落地（见 §7）。
7. ~~**Stage 5 · DAG 依赖与可配置重试**~~ ✅ 已落地：`dependsOn` 门控（受理期拒绝未知/已失败/超扇入/无队列，
   就绪才入队，失败与取消沿链级联，计入 `maxQueuedTasks`）与 `retry`（`maxAttempts`/`delayMs`/`fixed|exponential`/
   `maxDelayMs`/`onlyRetryable`，在终态写入前拦截、尝试归档于 `metadata.attempts`、token/成本跨尝试累加）。
   18 项新用例见 `test/dag.test.ts`（测试总数 82 → 100）。
8. **可选 Web 控制台**：可视化任务与远程 Worker 状态（结构化审计日志已提供数据源）。
9. ~~**Stage 6 · 远程部署补强**~~ ✅ 已落地：可选 mTLS、TLS 材料路径解析（`tls_invalid` 前置报错）、审计日志按大小轮转、
   systemd / Windows 计划任务开机启动、防火墙规则与 `docs/deploy.md` 双机手册；`npm run deploy:tls` 在本机真实网卡上
   跑通 9/9 检查。8 项新用例见 `test/deploy.test.ts`（测试总数 100 → 108）。
10. ~~**Stage 7 · 花费与审批预算**~~ ✅ 已落地，三层各自回答一个不同的问题：
    - **任务级 `budget: { maxTokens, maxCost }`** —— 墙钟管时间，这个管钱。每次 `usage` 上报时检查（不是事后），
      越界即 abort、以 `budget_exceeded` 结算为 `failed`，**次数统计跨所有尝试**（`usageBase` 已合并进判定，
      重试不会拿到新额度），且 `scheduleRetry` 显式拒绝重试它（重放只会再花一次）。成本上限只在币种一致时比较；
      不一致时**不生效**并在时间线上记一次 `budget_currency_mismatch`——把 2 分美元和 2 分人民币相比是单位错误，
      静默放行则更糟，所以选「明确不适用 + 留痕」。
    - **`limits.maxWaitingTasks`** —— 审批宽度。达到上限后新权限请求**当场拒绝**（`reject_once` / `decline`）
      而非挂起：worker 少一个工具但继续干活，扇出不会堆出一堵没人回答的问题墙、也不会白占并发槽。
      记 `approval_budget` 事件，让运维能区分「预算决策」和「审批链路坏了」。
    - **`limits.maxTotalTokens` / `maxTotalCost`** —— 进程级天花板。累计账由 `rollUpUsage` 的**增量**维护
      （ACP 报的是累计值，逐次相加会重复计费），越过后只拒新提交（`budget_exhausted`），**已受理的任务照常跑完**：
      取消它既找不回结果也退不了钱。`usage_summary` 增加 `budget` 段暴露余量，让 master 能在发下一批**之前**查。
    11 项新用例见 `test/budget.test.ts`（测试总数 108 → 119）。
11. ~~**Stage 8 · 团队层**~~ ✅ 已落地：把 worker 变成有名字的成员。
    - **成员 = 固定会话 + 工作区 + 记忆**：`sessionKey = team:<name>:<id>`，`MEMORY.md` 每轮注入；
      进程重启后会话从 harness 的会话库恢复，排队中的轮次继续，运行中的轮次标记失败并在频道里说明（不重放）。
    - **房间与 @ 提及**：频道声明成员范围，私聊按需出现；`@handle` 解析成轮次，回复原样入房间；
      DM 里无需 @ 即可对 partner 说话，被点名的队友会被拉进线程并留下。
    - **调度**：同一成员串行（一份 transcript 不能交织），成员之间并行；`maxHops` 与
      `maxTurnsPerMessage` 两道计数闸防止互 @ 风暴，撞闸时在频道里留下系统消息。
    - **透明与长期运行**：`team serve` 持有会话；`team status/log/transcript` 与 JSON API
      可按成员查看工具调用与阻塞状态（流式增量合并成可读的行），`team approve` / `team respond`
      直接解决卡住的轮次。
    12 项新用例见 `test/team.test.ts`（测试总数 142 → 155）。
12. ~~**Stage 9 · 自主心跳（pulse）**~~ ✅ 已落地：让成员在没人说话时自己醒来。
    - **pulse 是一轮没有触发消息的 turn**：`turns.messageId`/`rootId` 由 NOT NULL 放宽为可空
      （SQLite 无法原地放宽约束，因此做了一次**表重建迁移**，老库打开即补，历史行默认 `kind='message'`）。
    - **沉默是一等答案**：回 `SILENT` 什么都不发，连系统提示都不发——否则每次醒来都在群里刷
      「无更新」。什么都没发现的醒来对房间不可见，但仍在成员的 transcript 里。
    - **不插话**：`idleOnly`（默认）要求全队安静才醒，既不抢并发槽也不打断进行中的对话；
      `idleOnly: false` 留给需要在别人干活时汇报的负责人。
    - **不花别人的额度**：pulse 产生的消息自成一个 root，里面的 @ 拿全新深度/轮次额度；
      pulse 这个 turn 本身不属于任何线程，`countTurnsForRoot` 不会把它算进别人的线程。
    - `everyMs` 下限 1 秒（防止 50ms 醒来一次烧钱），每次醒来都是真实计费，预算天花板兜底；
      可选 `team pulse <member>` 手动戳一下，走同一套守卫。
    5 项新用例（定时器、SILENT、守卫、未配置、旧库迁移），测试总数 155 → 160。
13. ~~**Stage 10 · 只读 Web 控制台**~~ ✅ 已落地：`team serve` 在 `/` 上额外提供一个自包含的单页。
    - **只发 GET**：发消息、审批、叫醒成员都留在 CLI/API。一个谁都能在浏览器里打开的页面，
      不应该有能力让 agent 执行命令——这条不是靠文档承诺，而是靠页面里没有任何写路由。
    - **壳公开、数据鉴权**：浏览器无法给一次导航加 `Authorization`，所以 HTML 本身免鉴权
      （不含任何数据），页面自己向用户要 token 并存进 `sessionStorage`，每个数字都来自带鉴权的 GET。
    - **CSP 收紧**：`default-src 'none'` + `connect-src 'self'` + `frame-ancestors 'none'`，
      无外部资源、无 CDN、无构建步骤（`renderConsoleHtml` 就是一个纯函数，测试可直接断言产出的 HTML）。
    - **游标轮询**：与 CLI 同一个 `?after=` 游标，每 2 秒一次，`serve` 重启后页面自己接上；
      `/?member=<id>` 是可直接粘贴的深链，打开即展开该成员的逐轮过程（工具调用、阻塞、失败）。
    3 项新用例（壳公开而数据 401、团队名转义、内联脚本可编译），测试总数 160 → 163。
14. ~~**Stage 11 · 混合 harness 实证**~~ ✅ 已落地：把「成员只是一个 profile」这句话真跑一遍。
    - **一条真实的跨 CLI 交接链**：CEO 跑 pi、工程师跑 opencode、验证者跑 pi，同一个房间、同一道
      `maxHops` 闸、同一套 `MEMORY.md` 注入。产物 `greet.mjs` 由 opencode 写盘，pi 用 `node`
      真跑并把输出贴回来——六条成员消息、六轮成员轮次，全部 `succeeded`。
    - **跑出一个设计边界并写回文档**：提及是扇出不是排队。CEO 同时点了 @dev 和 @qa，验证者在产物
      还不存在时就开跑，诚实地报了 `ERR_MODULE_NOT_FOUND`，链直到工程师自己那条消息重新提及才收敛。
      房间背后没有依赖图，顺序只能靠措辞——这一步现在写在 `docs/team.md` 的调度一节。
    - **顺带补上 `driver: remote` 成员的空缺**：文档一直说成员可以跑在另一台机器上，但测试全是
      mock 直连。新用例让中间那个成员跑在真实 Worker Daemon 后面（loopback WS），两侧成员仍在本地，
      断言 daemon 侧确实有这条任务、本地只有一个被代理的任务、成员照常有 `sessionKey` 与转录。
    1 项新用例，测试总数 163 → 164。
15. ~~**Stage 12 · 会话轮换**~~ ✅ 已落地：给 harness 会话定个寿命。
    - **问题**：会话是唯一没有上限的东西，每一轮都把整段对话重发一遍，跑一天的成员每轮都在为早上的
      对话付费。`limits.maxTotalCost` 只截断花费，不阻止上下文变长（而且越长的上下文越贵）。
    - **代数由数据库算出来**：`sessionTurns: N` 之后 key 变 `team:<name>:<id>#k`，`k = 已结算轮次 ÷ N`。
      不新增「代数」字段，因此没有迁移、也不会因为重启把代数清零——计数和 key 都从同一个库里长出来。
    - **只换 key 不关进程等于没换**：轮换时把上一代的 worker 关掉（忙则留到下一轮），否则一代一个进程。
    - **连续性交还给本来该负责的东西**：房间、`MEMORY.md`、`notes`——每次轮换在房间里说一句，
      成员「失忆」看起来才像一次新会话，而不是一个缺陷。每轮把用的 key 记在 `turns.sessionKey` 上。
    2 项新用例（轮换 + 旧 worker 关闭、重启不倒退代数），测试总数 164 → 166。
16. ~~**Stage 13 · 白板**~~ ✅ 已落地：让成员接**没人点名**的活。
    - **问题**：用户往房间里发一条不带 @ 的消息，以前团队只能回一句「没人被点名」——那其实是
      **在找主人的活**。而房间本身就是队列，只是没有任何机制允许成员去取。
    - **认领是拉取，不是派活**：`members[].claims: [general]` 声明「我愿意接这个房间的无主活」。
      成员空闲时，最久没开口的那位先被问；接到的那一轮提示里明说「没人点你名，这件活在等你决定」。
      回 `SILENT` 就是把活放回白板（只挡自己，不挡别人）；轮次失败同理——失败不是对活本身的判决。
    - **原子性在 SQLite 里**：认领是一个 `BEGIN IMMEDIATE` 事务，两个成员同时醒来不可能都接走同一条。
      接线只在 `store.claimFor()` 一处，团队层不自己维护「谁拿了谁」的影子状态。
    - **白板会过期**：`claimTtlMs`（默认 1 小时）划出「活」与「历史」的界线——上周的一句感慨是用户
      的决定，不是团队该被提醒的事。只有**用户**发的无主消息上白板：成员之间的无 @ 汇报是对话，不是活。
    - **认领不等房间安静**：pulse 等安静，认领正好相反，前提就是这位空着、别人不空。
    - **真实 pi 上跑过两遍**：一条「Create a file named hello.txt…」被工程师认领并真的写盘，
      `turns.kind = claim`、`claims.decision = done`、产物在盘上，CEO 一次没被叫醒。第二条
      「Reminder to myself: 我还得定企业版定价」暴露了设计边界：模型宁可转交也不愿沉默，
      认领 → 甩给 CEO → CEO 说「@dev 不用管」又把它叫醒，一句自言自语烧掉三轮。在提示词里写明
      「用户写给自己的备注不是任何人的任务」之后，同一句变成一轮、零条消息、活留在白板上。
    5 项新用例（认领并完成、拒绝后回到白板、两个成员抢同一条只成一个、过期掉出白板、点名仍然直连），
    测试总数 166 → 171。
17. ~~**Stage 14 · 跨 OS 链路**~~ ✅ 已落地：把 master 和 worker 分到两个内核上跑。
    - **为什么不是「跨物理链路」**：WSL2 是同一台机器上的第二个内核，镜像网络让它拿到宿主机的
      同一个地址，所以 DNS、路由、中间防火墙、时延与重传一样都没有被跨过。跨过的是**内核边界**：
      两套 TCP/IP 栈、两套文件系统（ext4 与 NTFS，大小写与锁语义都不同）、两套信任库。
      把这两件事混成一句「跨物理链路未验证」是文档在说谎，已拆成两条写进 `verification.md`。
    - **跑法**：Windows 侧 master，WSL 侧 daemon。tarball 装进 ext4（不碰 `/mnt/d`，drvfs 的
      `fsync` 与锁语义会让 SQLite 出怪问题），daemon 在**对方内核**里自己生成 CA 与带 IP SAN 的
      服务器证书，master 只 pin 这个 CA。真 **opencode** 在 WSL 里干活：`from-wsl.txt` 落在
      `/dev/sdd`，`uname -sr` 答出 `Linux 6.18.33.2-microsoft-standard-WSL2`。
    - **跑出来的真 bug**：master 用**自己的** `path.resolve` 处理 remote profile 的 `cwd`，
      `/home/…` 变成 `D:\home\…`；daemon 在 Linux 上把 `D:\home\…` 当成**相对路径**，拼到 base 下，
      报「working directory not found」。同机 loopback 永远发现不了——两个 OS 才会。
      修复后 remote 的 `cwd` 原样过线，不写就一个字节都不发（由 daemon 用自己默认的），
      dispatch 结果里的 `cwd: ""` 就是「master 不知道」的诚实表示。
    - 1 项新用例（remote 的 cwd 不解析、同值在本地 profile 上会被解析），测试总数 171 → 172。
18. ~~**Stage 15 · 跨公网链路**~~ ✅ 已落地：两台机器、两个时钟、一条要改的防火墙规则。
    - **拓扑**：Windows master → 阿里云 ECS（Alinux 3，kernel `5.10.134-19.1.al8.x86_64`，
      NAT 后的 `172.24.24.182` / 公网 EIP `101.133.157.228`）。Node 22.20 从 tarball 装进
      独立的 `agentmesh` 账号，systemd 托管，`0.0.0.0:8790`，**双向 TLS**（`tls.ca`）+ Bearer token。
    - **补上的正是「网络边界」**：安全组不放行时客户端只会看到 `Opening handshake has timed out`，
      而服务器自己的 `firewalld` 早已放行——两层防火墙只有一层是 agentmesh 能看见的。
      审计日志里对端是 `171.83.30.166`（master 的公网地址），不是 loopback：这一跑确实出了机器。
    - **信任阶梯全绿**：无 CA `SELF_SIGNED_CERT_IN_CHAIN`；无客户端证书 `CERTIFICATE_REQUIRED`；
      用**别的 CA** 签的客户端证书 `ECONNRESET`；无 token `401`；双证齐 `200`，RTT ~100ms。
    - **跨机产物**：614433 字节的 `.diff` 作为交接附件发过去，落到 `<workdir>/handoffs/big.diff`，
      md5 一致，端到端 432ms（~1.4MB/s），审计记 `artifacts:1, artifactBytes:614433`。
    - **两个真 bug**（同机上都不可能暴露）：
      ① `make-certs.sh` 在 OpenSSL 1.1.1 上生成了带**两个** `basicConstraints` 的 CA
      （宿主机 `openssl.cnf` 的 `v3_ca` 与 `-addext` 各写一份），OpenSSL 因此不认它是 CA，
      `verify` 报「unable to get local issuer certificate」而文件看上去全对。改为用私有 config 文件
      指定扩展集，不再受宿主机 `openssl.cnf` 影响（Windows/OpenSSL 3.5 同时验证过）。
      ② 不带 `cwd` 的 submit 落在 **daemon 进程自己的目录**（systemd 下就是安装目录），
      而它一定不在 `allowCwd` 里，于是一个诚实说「我不知道对端布局」的 master 被
      `cwd_not_whitelisted` 拒掉。改为回落到该 profile 在 daemon 侧配置的 `cwd`。
    - 1 项新用例（不带 cwd 时用 daemon 侧 profile 的目录），测试总数 172 → 173。
19. ~~**Stage 16 · 白板的过期结算**~~ ✅ 已落地：到期的活不再静默消失。
    - **洞在哪**：`claimTtlMs` 被 `store.board()` 和 `unclaimedCount()` 同时用作「消息年龄」过滤，
      于是过期的活从白板和状态行一起消失。按设计它确实「不该再催团队」，但「团队四个都读过、
      四个都说不」是**要用户拍板的判决**，它跟着一起消失了。用户晚上发一条无主活，第二天
      `team board` 是空的、`status` 是 0、四个人都闲着——没有任何地方说「没人做过」。
    - **只报告，不接管**（用户明确选择）：`team board` 在在办条目下面单列 `expired` 段并标出
      谁拒过，`team status` 首行加 `N expired`，`GET /team/board` 多一个 `expired` 字段，
      `team transcript` 之外的地方都可见。**不重新派活、不硬塞给成员**——反复去问一个已经说不的
      成员，只会把预算耗在打转上（`4e26d9e` 实跑见过模型转交 3 轮）。
    - **噪音边界**：从来没人被问过的条目（房间没启用 `claims`）完全不报——那里没有任何人拒绝过
      什么，报出来是对一个没打开的功能发牢骚。被拒后又被别人做完的也不报，那是做完了的活。
    - **已经好的那条不用动**：认领后进程崩溃残留的 `taken`，`interruptLiveTurns()` 在启动时
      已经改回 `dropped` 回板并在频道里留系统消息（`team.ts:245`），不是这次要修的东西。
    - 2 项新用例（过期且被拒要报、没人问过的不报），测试总数 173 → 175。
20. ~~**Stage 17 · 重启对账**~~ ✅ 已落地：队列在内存里，记录不在。
    - **问题**：`TaskManager` 的队列是内存数组，任务记录在 SQLite。进程被 kill 之后，记录里还写着
      `queued`/`running`/`waiting`，而没有任何东西能推动它们——`task_list` 永远显示一条跑不完的任务，
      `status` 把没人做的活算成在做。团队层早就有 `interruptLiveTurns`，任务层没有，**这本身就是
      不一致**。
    - **做法**：`reconcile()` 把四种非终态记录结算成 `failed` + `error.code = "interrupted"`，并写一条
      事件把原因留给读任务的人。**不重放**：`running` 的任务可能已经改过文件；`waiting` 的更不可能
      ——它的审批存在上一个进程的内存里，早就没了。
    - **没有放进构造函数**（第一版就是这么写的，被测试抓住了）：短命令（`dispatch`、`task_list`）
      是独立进程，可能和正在跑的驻留进程共用同一个 workdir。在那里 sweep 会把**活着的任务**标死，
      随后还会因为两个 store 各自算 `MAX(sequence)+1` 而撞 `UNIQUE`。改成只有「这个 workdir 的
      唯一属主」才调用：`team serve` 与远程 daemon 启动时各调一次。
    - **没做的**：不把 `queued` 重新入队（`pump()` 依赖内存里的 `live` 记录，重建它属于另一件事），
      `blocked`/`backoff-waiting` 也一并结算而不是重新评估依赖。
    - 1 项新用例（四条记录覆盖四种状态 → 三条结算、终态不动、事件带原因），测试总数 175 → 176。
    - 顺带修掉 `verification.md` 里一条**过时**的 gap：跨机附件早已跑过公网 + mTLS（Stage 15），
      原文还写着「loopback-only」。

> Stage 0–3 已完成并通过 176 项测试（含真实 opencode/pi、loopback 远程端到端、密钥轮换、审计日志、递归守卫、资源上限、Stage 5 有界队列 + 队列 TTL/截止时间 + 加权公平、DAG 依赖与退避重试、自托管 master 技能、跨 Worker 交接 Phase 1–3：result 注入 / 脱敏 diff sidecar / 前驱末态 worktree、结构化结果契约 + token/成本汇总、远程部署补强：mTLS / 审计轮转 / 真实网卡 TLS 验证，以及花费与审批预算、团队层与自主心跳、混合 harness 实跑、会话轮换、白板认领、跨 OS 链路、跨公网链路、白板过期结算、重启对账）。
> 下一步：按**域名**而不是 IP 访问（证书 SAN 得对上 DNS）、真正会丢包的链路、未做 NTP 对时的时钟。
> 域名这一条不必等自有域名：`IP.nip.io` / `IP.sslip.io` 这类通配 DNS 已验证可解析到目标 IP，
> DNS 解析路径、SNI、`DNS:` 类型 SAN 都能真实测到；测不到的只有「改 A 记录切后端」那一层。
