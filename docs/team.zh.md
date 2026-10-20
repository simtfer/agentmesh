# 团队：有名字的成员，共享的房间

**团队（team）** 是 worker 之上的一层。worker 是执行槽位；成员是有名字、有职责、有工作区、
有可延续的对话和记忆文件的同事。成员在房间里说话，`@提及` 就是把下一轮交给某个同事的动作。

这不是「master 把任务拆成子任务」。团队层不决定谁做什么：用户点名，成员彼此点名。
路由引擎只负责投递消息，并给对话加上边界。

```
         你
          │  发言 / 私聊
          ▼
   ┌─────────────── team 进程 ──────────────────┐
   │  频道 + 私聊（SQLite）    每个成员的收件箱   │
   │        │                        │           │
   │        └──── @提及 ─────────────┘           │
   │                 │                           │
   │      ┌──────────┼──────────┐                │
   │      ▼          ▼          ▼                │
   │    Mira       Sam        Lin                │
   │  （CEO）    （工程师）   （验证）            │
   │  会话+记忆   会话+记忆   会话+记忆           │
   └─────────────────────────────────────────────┘
```

每个成员都是一个固定会话的 agentmesh worker：`sessionKey = team:<name>:<member id>`。
就是这一个细节让人「持续存在」——下一轮、以及进程重启之后，恢复的是同一个 agent 会话和它的历史。

一个成员*只是一个 profile*，而 profile 只是一个驱动，所以同一份名册可以混着用不同 harness：
CEO 用 pi，工程师用 opencode，验证跑在另一台机器上走 `driver: remote`。房间不关心是哪个 CLI 在回答，
它只看见成员。

## 快速开始

```yaml
# agentmesh.yaml
workdir: .agentmesh

profiles:
  - name: claude-code
    driver: acpx
    agent: claude              # acpx 内置名，或自定义 command
  - name: pi
    driver: acpx
    agent: pi

team:
  name: acme
  port: 4317
  tokenEnv: AGENTMESH_TEAM_TOKEN   # 值只放在环境变量里
  members:
    - id: ceo
      name: Mira
      role: 拆解目标、分配工作、向用户汇报
      profile: claude-code
      notes: 汇报要短。只在周五发布。
    - id: dev
      name: Sam
      role: 工程师，写代码、修问题
      profile: pi
    - id: qa
      name: Lin
      role: 验证者，测试做出来的东西
      profile: pi
  channels:
    - id: general
      description: 全员
    - id: ops
      members: [ceo, qa]        # dev 在这个房间不可被点名
```

```bash
agentmesh team serve --config agentmesh.yaml   # 常驻
agentmesh team chat                            # 和房间对话
```

`team serve` 是长期运行的部分：agent 会话归它所有。CLI 只是它 JSON API 的客户端，
关掉终端不会杀掉团队。

## 成员名册

| 键 | 含义 |
|---|---|
| `id` | 稳定身份；默认同时是 `@handle` |
| `name` | 展示名，队友看到的名字 |
| `role` | 一行职责，注入每个队友的 prompt |
| `profile` | 这个成员由哪个 harness 运行（`claude`、`pi`、`opencode`……） |
| `mention` | 不带 `@` 的句柄；默认等于 `id`；id 与句柄必须唯一 |
| `cwd` | 工作区；相对 `team.cwd`，再相对 mesh 根目录 |
| `notes` | 常驻说明，每轮前置注入 |

两个成员可以共用一个 profile——会话依然独立，因为 session key 里含成员 id。
两个成员**不能**共用句柄；团队会直接拒绝启动，而不是猜 `@dev` 指的是谁。

`profile` 就是混合技术栈所在：CEO 可以是 Claude Code，工程师是 Pi，验证者是 OpenCode。
团队层只看见「一个成员」。

## 房间、私聊与提及

**频道**在配置里声明。`members` 限定谁在这里可被点名；不写就是全员。点到一个不在这个房间的人，
不会路由，频道里会出现一行系统提示（静默不投递看起来就像对方无视了请求）。

**私聊**不用声明：`dm:user:<member>` 因为有人说过话而存在。用户在私聊里说话**不需要 @**——
这个窗口里本来就只有一个人。私聊里被点名的队友会被拉进这条线，并在此后一直是参与者，
所以一次介绍是持久的。

**提及**从消息文本里解析：`@ceo`、`@dev`，大小写不敏感，支持 Unicode 字母（`@研发`）。
邮箱形态不算提及（`a@dev.io` 不会匹配）。`@user` / `@you` / `@human` 是找人类，永不排队。

成员的回复**原样**进入房间。协议就这一条：成员写的是消息，不是关于消息的汇报；聊天记录就是状态。

## 轮次、调度与两道闸

一条带提及的消息，会为每个被提及的成员创建一个**轮次（turn）**。一个轮次就是该成员固定会话上的
一个 agentmesh 任务。

- **同一成员串行。** 一份对话里不能交织两段 prompt，所以成员的收件箱是 FIFO，
  上一轮结算后才开始下一轮。
- **成员之间并行。** 不同的人可以同时干活；团队把 `limits.maxConcurrentTasks` 当作背压
  （多出来的轮次留在名册里排队，而不是在任务调度器里被拒）。`0` 表示团队层不设上限。
- **深度闸。** `team.maxHops`（默认 6）限制一条消息能传多远；到达上限的轮次不能再交接。
- **线程闸。** `team.maxTurnsPerMessage`（默认 16）限制一条根消息引发的总轮次，
  防止一次点名变成全公司风暴。

两道闸都是**计数**的，撞上时会在房间里发系统消息（「not queued: @dev（hand-off depth 6 reached）」），
而不是静默失败。

**提及是扇出，不是排队。** 一条消息点两个人，两个人同时开始。并行就是这么来的，也正是
「和干活的人一起被点名的验证者，可能在产物还不存在时就开跑」的原因：房间背后没有依赖图，
**顺序只能靠措辞**——需要先后时，一步只点一个人。一次真实的 pi + opencode 运行把这点摊开了：
CEO 把两个人都点了，验证者诚实地报了 `ERR_MODULE_NOT_FOUND`，链直到工程师自己那条消息又提了一次
才收敛——三步的活发了六条成员消息，其中两条是噪声。

每个轮次的 prompt 包含：成员身份与职责、当前房间和里面的人、最近的聊天记录、触发消息、
成员的 `notes`，以及它 `MEMORY.md` 的内容。它还会说明回复约定——回复会原样发到房间，
写 `@handle` 会给对方排一轮——这是成员唯一需要学会的「团队协议」。

## 记忆与连续性

三样东西会持久化，而且它们不是一回事：

| 什么 | 在哪 | 重启后 |
|---|---|---|
| 对话历史 | agent 自己的 ACP 会话，按 `sessionKey` 寻址 | 会，从 harness 的会话存储恢复 |
| 长期笔记 | `<stateDir>/members/<id>/MEMORY.md` | 会，就是普通文件 |
| 收件箱 | `<stateDir>/team.sqlite` 的 `turns` 表 | 排队中的会；运行中的标记失败，不重放 |

`MEMORY.md` 在每轮开始时读取（上限 4 KB），并把路径告诉成员，让它自己追加决策、偏好与背景。
它就是磁盘上的普通文本：可审阅、可 diff、可手改。

进程停止时**正在运行**的轮次会被标记失败，并在对应频道里说明。它不会被自动重放：
agent 可能已经改过文件，静默重试可能把同一个改动做两遍。排队中的轮次从未开始，下次启动会继续跑。

### 给对话定个寿命

harness 会话是唯一没有上限的东西：每一轮都要把整段对话重新发一遍，所以一个从早上干到下午的成员，
每一轮都在为「早上」付钱。`sessionTurns` 给它一个寿命。

```yaml
team:
  sessionTurns: 40          # 所有人，除非成员自己另说
  members:
    - id: qa
      profile: pi
      sessionTurns: 10      # 验证者的轮次很短，可以换得更勤
```

- **代数（generation）是算出来的，不是存的。** 成员的 key 在前 N 轮是
  `team:<name>:<id>`，之后是 `team:<name>:<id>#k`，`k = 已结算轮次 ÷ N`。两个数都在 SQLite 里，
  所以重启之后接着当前这一代，而不是悄悄从头再来。
- **旧 worker 会被关掉。** 只换 key 不关进程，会留下「每一代一个 agent 进程」——正好是这个功能
  想省掉的开销。上一代在下一轮开始时关闭（若正忙则留到再下一轮重试）。
- **连续性靠房间，不靠会话。** 换过之后的那一轮照样拿到成员的身份、`notes`、最近的聊天记录和
  `MEMORY.md`，房间也会在每次轮换时说一句。它在意的事必须落在这些地方——这也是 prompt 一直要求它
  「把决定写下来」而不是指望对话记忆的原因。
- **按轮记账。** 每一轮都记下自己跑在哪个 key 上（`team transcript` 会打印），所以「这个成员什么时候
  换的新对话」是数据里的事实，不是靠时间猜。

## 自己醒来：pulse

只会被点名才开口的成员，是很灵敏的工具，不是同事。`pulse` 让成员按自己的节奏醒来，判断房间
是否缺了点什么——一个跑完的结果、一个风险、一件它能接过去的活。

```yaml
team:
  members:
    - id: ceo
      name: Mira
      profile: pi
      pulse: { everyMs: 600000, idleOnly: true }   # 每 10 分钟
```

pulse 是一轮**没有触发消息**的普通轮次：成员看到当前房间的样子、以及房间安静了多久，然后被问到
有没有值得说的话。三条规则保证它不会变成噪音：

- **`SILENT` 是预期答案。** 回 `SILENT` 就什么都不发——连「已检查，无更新」的系统提示都没有。
  一次什么都没发现的醒来，对房间不可见，但在该成员的 `transcript` 里仍然留着。
- **它不插话。** 默认 `idleOnly`，只有整个团队都安静时才醒，所以不会跟真实的活抢并发槽，
  也不会打断正在进行的对话。要让负责人能在别人干活时汇报进度，才设 `idleOnly: false`。
- **它自起一条线程。** pulse 产生的消息自己就是 root，所以里面的 `@提及` 拿的是全新的深度/轮次
  额度，而不是消耗房间里碰巧最后那段对话的额度。

`everyMs` 下限 1 秒、无上限；每次 pulse 都是**真实计费的一轮 agent**，所以分钟级才是合理区间，
`limits.maxTotalTokens` / `maxTotalCost` 是兜底。不配置 `pulse` 的成员行为与之前完全一样——
默认关闭。

pulse 用的是成员**正常的工具权限**——它还是同一个 agent，只是被定时器叫醒而不是被消息叫醒，
所以一次没人要求的轮次**可以**改文件。护栏是 profile 的 `permissionMode`、花费天花板，以及每次 pulse
事后都能在该成员的 transcript 里看到。

想手动戳一下，用 `agentmesh team pulse <member>`（同样受守卫：房间在忙就继续睡，并如实告诉你）。
`team status` 会标出谁有自己的节奏，`team transcript` 会把这类轮次标成 `(pulse)`。

## 观察工作过程

群聊不是 CEO 写的总结。每个成员的轮次都和它背后的任务事件一起存着。

```bash
agentmesh team status                     # 谁空闲 / 在跑 / 等审批
agentmesh team log general --limit 20     # 房间记录，含系统提示
agentmesh team transcript dev --limit 5   # dev 实际做了什么，逐轮
agentmesh team dm qa "有风险吗？" --wait    # 私聊并等回答
agentmesh team approve <approvalId> allow_once             # 权限请求
agentmesh team respond <approvalId> accept --content '{}'  # elicitation 提问
```

`transcript` 展示的是每一轮的 agent 工具调用和状态事件，不只是最终文本——和任务 API 看到的是
同一批事件，只是按成员切开了。流式 harness 每个 token 报一个事件，transcript 会把**同一流上
连续的增量合并成一行**，并标出流名与增量数（正式回答是 `text×20`，思考过程是 `thought×33`），
而工具调用仍是一行一个，因为每次调用都是一个独立的动作。

`approve` 和 `respond` 刻意分开：权限请求是一个**决定**（`allow_once`、`reject_always`……），
elicitation 是一个**回答**（`accept` / `decline` / `cancel` 加内容）。底层是同一个 broker，
问题不同。

| 端点 | 用途 |
|---|---|
| `GET /team` | 状态、成员、频道、待审批 |
| `GET /team/channels` | 已存在的房间与私聊 |
| `GET /team/messages?channel=&after=&limit=` | 分页记录（把 `after` 当游标） |
| `POST /team/messages` | `{channel, text}`，或 `{to, text}` 走私聊；返回它排出的轮次 |
| `GET /team/turns/<id>` | 单个轮次的状态——等待中的 CLI 靠它跟进 |
| `GET /team/members/<id>/transcript?limit=` | 轮次 + 任务事件 |
| `GET /team/approvals` · `POST /team/approvals` | 列出并处理阻塞（权限用 `decision`，elicitation 用 `action` + `content`） |

API 是 JSON，且刻意做得无聊：带游标轮询。一轮团队对话可能跑几分钟，
游标能扛住重启、断线，以及一个被关掉的 CLI。

## 控制台

`team serve` 会在同一个地址上额外提供一个只读控制台：

```text
http://127.0.0.1:4317/
```

左边是成员栏（谁在跑、谁在排队、谁被卡住、谁有自己的节奏），中间是房间记录，
右侧抽屉是某位成员的逐轮过程。`/?member=qa` 直接展开那位成员的抽屉——"看看 Lin 在干什么"
是一个可以粘贴的链接，而不是一连串点击。

它是一个自包含的 HTML 文档：没有外部资源、没有 CDN、没有构建步骤，而且**只发 GET**。
发消息、审批工具调用、叫醒成员仍然只在 CLI 和 API 里——一个谁都能在浏览器里打开的页面，
不应该有能力让 agent 去执行命令。

即使 API 要求 token，页面本身也是公开的（浏览器没法给一次导航加上 `Authorization` 头）；
页面会向你要 token，存在 `sessionStorage`，屏幕上的每个数字都来自它自己发的、带鉴权的请求。
实时性用的是 CLI 同一个 `?after=` 游标，每两秒轮询一次，所以 `serve` 重启后页面自己接上。

## 安全

团队 API 能让 agent 在这台机器上执行工具，所以它等价于本地 shell：

- 默认只绑 `127.0.0.1`；
- 绑非 loopback 地址**必须**带 bearer token（`team.tokenEnv`，值只来自环境变量）；
- 要出机器就自己在前面加 TLS（反向代理）——内置服务器不做 TLS 终止；
- 每个成员的工具权限仍由它的 harness profile（`permissionMode`、harness 自身配置）决定，
  不是团队层授予的。

## 这一层的边界

把话说清楚，免得期待超出实际：

- **控制台是只读的。** `team chat`、`team log`、HTTP API 和 `/` 上的页面就是界面。页面展示房间
  和每条消息背后的轮次，但它不能发言、不能审批、不能叫醒任何人——那些仍然留在 CLI 里。
- **主动行为要自己开。** 默认成员仍然只在被点名或被提及时说话；想让它定时醒来就用
  `pulse`，但要清楚每一次醒来都是一轮真实计费。没有做的是「从任务队列里自己认领活」——
  房间就是队列。
- **默认共享 checkout。** 成员默认同一个 `cwd`，互相看得见文件。要隔离，就给每个成员预先建一个
  稳定的 worktree 目录并设为 `cwd`——**不要**用 `worktree: true`，它与固定会话冲突
  （每次 spawn 新路径会让会话静默重开）。
- **一个进程一个团队。** 两个团队需要两个 `serve` 进程，`stateDir` 和端口都要分开。
- **成本是真的。** 每轮都是真实 harness 上的完整 agent 轮次；成员并行会成倍花钱。
  用 `limits.maxTotalTokens` / `maxTotalCost` 做进程级上限。

## 故障对照

| 症状 | 原因 | 处理 |
|---|---|---|
| CLI 报 `401 unauthorized` | 客户端 token 缺失，或与服务端不一致 | 两边都设 `AGENTMESH_TEAM_TOKEN`（或 `--token-env NAME`） |
| `team server returned 404: no such channel` | 频道名写错，或给不存在的成员发私聊 | `agentmesh team channels` |
| `@某人` 之后没反应 | 对方不在这个频道，或撞上了两道闸 | 看 `team log` 里的系统提示 |
| 某个成员一直不回 | 它的 harness 没装好/没登录 | 在团队外单独跑一次该 profile；见 `agentmesh list` |
| 轮次失败 `session ... busy` | 残留任务还占着会话 | 团队本身按成员排队；持续出现就 `agentmesh tasks` 等它结算 |
| 重启后出现 `interrupted` | 进程在轮次中途停了 | 重新发一次；排队中的已经自动继续 |

相关：[`configuration.md`](./configuration.md)（全部配置键）、[`cli.md`](./cli.md)（命令）、
[`verification.md`](./verification.md)（测试覆盖）、[`remote.md`](./remote.md)
（成员跑在另一台机器上时用 `driver: remote` profile）。
