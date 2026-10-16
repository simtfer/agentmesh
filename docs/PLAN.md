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

3. **路线图前移**：Stage 0（协议可行性）大部分被 acpx 覆盖，Stage 1（单机 Adapter）骨架已完成并通过测试。
   真正的**未完成关键项**是：对**真实 pi/opencode 进程**的验证、**8 态任务状态机**、**SQLite 持久化**、**远程 Worker**。

---

## 1. 现状：已落地并验证（agentmesh MVP）

代码位置：`D:\Programs\QoderCN\tmp\agentmesh`。验证环境：Windows / Node v24 / npm 11 / git 2.55。

| 能力 | 状态 | 位置 / 证据 |
|---|---|---|
| ACP Worker 驱动（acpx 进程内 runtime） | ✅ 代码完成，⚠️ 未对真实 pi/opencode 跑通 | `src/drivers/acpxDriver.ts` |
| Mock Worker（离线、确定性、零成本） | ✅ 完成 | `src/drivers/mockDriver.ts` |
| Orchestrator：spawn / dispatch / collect / kill | ✅ 完成 | `src/orchestrator.ts` |
| Worker 注册表 + 事件环形缓冲 | ✅ 完成 | `src/registry.ts` |
| git worktree 并行隔离 | ✅ 代码完成（未在真实仓库跑） | `src/worktree.ts` |
| MCP Server（6 工具，stdio） | ✅ 完成，握手验证通过 | `src/mcp/server.ts` |
| CLI：demo / list / mcp / dispatch | ✅ 完成 | `src/cli.ts` |
| 配置：YAML + zod 校验 | ✅ 完成 | `src/config.ts`、`agentmesh.yaml` |

**验证结果**：`tsc --noEmit` 与 `npm run build` 干净通过；`npm test` 6/6；`npm run demo` 闭环 `CLOSED ✅`；
`npm run smoke` 真实 MCP stdio 握手 + `tools/list`(6) + `dispatch_task`→`completed`。

**唯一验证缺口**：acpxDriver 未对**真实 `pi`/`opencode` 子进程**运行过（需安装+登录+联网，且产生 token 费用）。
代码严格对照 acpx 发布的 `runtime.d.ts`（`createAcpRuntime`/`ensureSession`/`startTurn`/`turn.events`/`turn.result`）编写。

---

## 2. v1.0 设想 ↔ MVP 现状 ↔ 决策

| v1.0 设想 | MVP 现状 | 决策 |
|---|---|---|
| 自研通用 ACP Client | 复用 acpx runtime | **采纳 acpx**，`adapter-acp` = acpx 封装 |
| 直接依赖第三方 `pi-acp`（nicobailon） | acpx 内置 `pi → npx pi-acp`（svkozak, v0.0.34） | 采纳；桥早期，保留 `PiRpcAdapter` 备用 |
| 8 态任务状态机（含 waiting/timed_out） | 3 态（completed/cancelled/failed） | **升级为 8 态**（Stage 1 收尾） |
| SQLite 任务持久化、重启可查 | 无（仅 acpx 会话文件） | **新增**（Stage 2） |
| 远程 Worker Daemon（HTTP/WebSocket） | 仅本地 | **未开始**（Stage 3） |
| Adapter 受理语义 `startTask/getStatus/subscribe` | `WorkerHandle.runTurn`（同步收集） | 演进为**受理式异步**语义 |
| MCP 工具 `agent_*/task_*` | `list_profiles/spawn_worker/dispatch_task/…` | **合并命名**（§5） |
| monorepo `apps/`+`packages/` | 单体 `src/` | 暂缓拆包，先保持模块边界清晰，Stage 3 再拆 |
| Worker 心跳/在线状态 | 无（本地进程） | Stage 3 随远程引入 |

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
│  State Machine ⏳(3态→8态)  Store ⏳(SQLite) │
│  Policy Manager ⏳   Audit Log ⏳            │
└──────────────┬──────────────────┬────────────┘
               │ Local (in-proc)   │ HTTP/WebSocket   【⏳ Stage 3】
               ▼                   ▼
┌────────────────────────┐  ┌────────────────────────┐
│ Local Agent Runtime    │  │ Remote Worker Daemon   │
│ = acpx runtime ✅      │  │ 注册/心跳/执行/监督 ⏳ │
│ ACP over stdio         │  │ 本地再起 acpx/ACP      │
└────────────┬───────────┘  └────────────┬───────────┘
             │ stdio JSON-RPC            │ stdio JSON-RPC
             ▼                           ▼
     ┌──────────────┐            ┌──────────────────┐
     │ Agent Process│            │ Remote Agent     │
     │ pi/opencode  │            │ pi/opencode/…    │
     └──────────────┘            └──────────────────┘
```

图例：✅ 已实现 · ⏳ 待实现。**关键设计不变**：ACP stdio 从不跨网络暴露；远程由 Worker Daemon 在本机启动 ACP 子进程，
Orchestrator↔Daemon 走**带认证的 HTTP/WebSocket**。

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
`waiting` 需来自 ACP 权限/elicitation 回调（`onPermissionRequest`/`onElicitation`），MVP 尚未接线。

---

## 5. MCP 工具对齐（合并 v1.0 §7 与 MVP 已实现）

| 目标工具（v1.0） | MVP 现有 | 差距 / 动作 |
|---|---|---|
| `agent_list` | `list_profiles` + `list_workers` | 合并：返回 id/kind/online/capabilities |
| `agent_inspect` | `get_worker_status` | 补版本、运行中任务、最后心跳 |
| `task_submit`（受理，返回 taskId） | `dispatch_task`（**同步等待**） | **拆分**：submit 立即返回；新增 wait/status |
| `task_status` | 部分（get_worker_status） | 独立任务级查询 |
| `task_wait`（到终态或超时） | ❌ | 新增；进入 waiting 要返回原因，不得误报成功 |
| `task_result`（大产物用引用/分页） | 内联在 dispatch 返回 | 新增；文本/日志分页 |
| `task_cancel`（确认后才 cancelled） | `kill_worker`（关会话） | 补任务级取消 + 确认语义 |
| `task_events` | 事件缓冲在 registry | 暴露为工具（按 sequence 分页） |
| `spawn_worker` | ✅（MVP 独有，保留） | 保留：预热 worker / worktree |

**安全边界（v1.0 §7.8，全部保留）**：Master 不能指定未批准的可执行文件；工作目录白名单；
远程 Worker 只接受授权 Master；**Agent 输出视为不可信数据，绝不当作系统指令**；高风险/删除/凭证操作走人工批准。
acpx 侧对应：`permissionMode`（`deny-all|approve-reads|approve-all`）+ `onPermissionRequest` 回调。

---

## 6. 修订路线图（含已完成状态）

### Stage 0 · 协议可行性验证 —— 🟡 大部分完成
- ✅ 经 acpx 覆盖：ACP 初始化/会话/prompt/事件/取消/退出的客户端侧。
- ⏳ **关键未完成**：对**真实 `opencode acp` 与 `pi`(pi-acp v0.0.34)** 各跑通一次任务，记录：命令/参数、能力协商、
  流式事件、**取消的真实行为**、会话恢复限制、版本与许可证。
- 验收：两种真实 Agent 都能程序化提交任务、收到结束/错误事件、确认可取消、记录不可统一的功能差异。
- 阻塞项：需你授权一次**可能产生 token 费用**的真实调用（pi/opencode 已登录）。

### Stage 1 · 单机 Adapter —— 🟡 骨架完成
- ✅ `AgentAdapter`/事件类型、OpenCode/Pi（经 acpx）、Mock Adapter、统一错误/超时雏形。
- ⏳ 3 态→**8 态状态机**；`startTask` **受理式异步**；`subscribe`/`cancel`/超时在各 Adapter 行为一致；
  接线 `waiting`（权限/elicitation 回调）。
- 验收：同一套测试跑不同 Adapter；流式输出不会重复结束；Agent 异常退出可检测。

### Stage 2 · Orchestrator + SQLite + MCP —— 🟡 MCP 完成
- ✅ Agent Registry、MCP 工具（6）、查询/取消/结果的同步版。
- ⏳ **SQLite 持久化**（任务/Agent/会话/事件元数据）；`task_submit/wait/status/result/cancel/events` 全量；
  Task Scheduler（并发上限）；重启后已存任务可查；结构化审计日志。
- 验收：OpenCode Master 经 MCP 调 Pi Worker；可查状态取结果；**服务重启后任务仍可查询**。

### Stage 3 · 远程 Worker —— ⬜ 未开始
- Worker Daemon：注册/心跳/认证、HTTP+WS 协议、远程本机起 acpx/ACP、断线重连与**状态对账**、事件序号去重。
- Windows：路径规范化、子进程 stdio、残留进程清理、开机启动/日志轮转、防火墙、密钥轮换。
- 验收：电脑 A 调用电脑 B 的 Pi；输出/结果回到 A；**断线不把运行中任务误判成功**；重连后可查远程状态。

### Stage 4 · 双向角色 + 第二种 Worker —— 🟡 概念已验证
- ✅ demo 已证明“角色对称、由配置决定”（同一 Orchestrator，master 只是挂 MCP 的一方）。
- ⏳ 用**真实** Agent 跑通四组合：OpenCode→Pi、OpenCode→OpenCode、Pi→OpenCode、Pi→Pi，端到端自动化测试。

### Stage 5 · 并行与代码工作流 —— ⬜ 未开始
- 并发限制、独立 git worktree（代码已备）、DAG 依赖、可配置重试、人工审批与预算、可选 Web 控制台。
- 验收：多任务并发；同一工作目录不被多个写任务无保护同时改；失败/超时/取消路径均有测试。

---

## 7. 安全与可靠性（v1.0 §13 全保留 + 补充）

远程认证 + TLS/可信通道；不向局域网暴露未保护的 ACP stdio 桥；工作目录白名单；命令/工具权限最小化；
密钥从环境变量或安全凭证存储读取（**不入配置文件/版本库**）；结构化审计日志；超时/最大并发/输出大小限制；
**防无限递归委派**（Master 也是 Agent，需深度/预算上限）；Agent 输出视为不可信；不可逆操作人工确认；
记录 Agent/Adapter/协议版本。
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
| **递归委派失控** | Master 侧深度/预算/并发上限 |

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

1. **Stage 0 收尾（关键）**：对真实 `opencode acp` 与 `pi` 各跑一次冒烟——需你确认二者已登录，并授权一次可能计费的调用。
2. **状态机 3→8 态 + SQLite 持久化**：把 `dispatch` 拆成 `task_submit`(受理) + `task_status`/`task_wait`/`task_result`。
3. **接线 `waiting`**：把 acpx 的 `onPermissionRequest`/`onElicitation` 映射为 `waiting` 事件 + 批准工具。
4. 之后再进入 Stage 3 远程 Worker（HTTP/WS + Daemon）。

> 是否按此顺序推进？其中第 1 步需要你的授权与本机已登录的 pi/opencode；第 2、3 步我可以直接在现有 `agentmesh` 代码上实现并用 mock 跑通验证。
