# 双机指南：A（master）与 B（worker）怎么配、怎么起

[`quickstart.zh.md`](./quickstart.zh.md) 是十五分钟跑通一单的版本。这一篇是同一套部署的参考手册：
每个开关是什么意思、Linux 和 Windows 各自怎么起、怎么开机自启，以及怎么区分“软件坏了”和“部署错了”。

生产加固（私有 CA、双向 TLS、防火墙、轮换、systemd）另有运维手册：[`deploy.md`](./deploy.md)。
本篇讲配置与启动，运维流程去那边看。

下文所有例子固定用这一对角色：**A 是 Claude Code**（master，也就是 MCP 客户端），
**B 是 pi**（worker，由 `acpx` 驱动的 ACP agent）。这不依赖具体是哪两个 agent——换掉任意一侧，
改的只是配置。

## 目录

- [拓扑与信任边界](#拓扑与信任边界)
- [两台机器各自需要什么](#两台机器各自需要什么)
- [B 机：worker](#b-机worker)
- [A 机：master](#a-机master)
- [`cwd` 的契约](#cwd-的契约)
- [逐级验证](#逐级验证)
- [开机自启](#开机自启)
- [日常运维](#日常运维)
- [故障对照表](#故障对照表)
- [安全清单](#安全清单)
- [验证到了哪一步](#验证到了哪一步)
- [接下来读什么](#接下来读什么)

## 拓扑与信任边界

```
A 机 —— master                                  B 机 —— worker
┌────────────────────────────────┐              ┌──────────────────────────────────┐
│ Claude Code（MCP 客户端）      │  WSS :8790   │ agentmesh daemon                 │
│ node dist/cli.js mcp           │ ───────────▶ │  HTTP  /healthz  /profiles       │
│ profile: driver: remote        │              │  WS    /ws（带类型的任务事件）   │
│ token 从环境读，无入站端口     │ ◀─────────── │  TLS（+ mTLS）、bearer token     │
│                                │    事件      │ 本机 ACP agent：pi（acpx）──▶ ACP│
└────────────────────────────────┘              └──────────────────────────────────┘
```

线上跑的是：带类型的控制消息（`submit`、`approve`、`respond`、`cancel`、`attach`、`query`）与任务事件。
线上**不跑**的是 ACP stdio 桥：agent 进程由 daemon 在 B 上拉起，从不直接和 A 对话。

所以动手配之前，先记住两条推论：

- **队列在 A，agent 在 B。** 重试、预算、DAG 门控、任务库都属于 A；工作树、工具执行、agent 能读到的密钥都属于 B。
- **B 才是安全边界。** 让远程 worker 站得住的那些东西——`allowCwd`、token、TLS、mTLS——全部在 B 上强制执行。A 只是调用方。

## 两台机器各自需要什么

| | A 机（master） | B 机（worker） |
|---|---|---|
| Node.js | ≥ 22.13 | ≥ 22.13 |
| agentmesh 构建产物 | `dist/cli.js` | `dist/cli.js` |
| agent 本身 | **Claude Code**（`PATH` 上有 `claude`），通过 stdio MCP 接入 | **pi**，装好并登录；`acpx` 以 `npx pi-acp` 驱动它 |
| `openssl` | 只在检查证书时用 | 需要，用来生成 CA 与证书 |
| 入站端口 | **没有** | TCP 8790（或 `daemon.port` 指定的端口） |
| 出站 | → B:8790 | → agent 自己要访问的东西 |
| git | clone 用 | clone 用，且 `worktree: true` 的 profile 需要它 |

两台机器的 agentmesh 版本要一致：线上协议带版本号，某个 daemon 太旧不支持某项能力时，会在握手阶段
直接拒绝，而不是做到一半才失败。

## B 机：worker

### 安装，并给它一个独立账号

```bash
git clone https://github.com/simtfer/agentmesh.git /srv/agentmesh
cd /srv/agentmesh && npm ci && npm run build
sudo useradd --system --create-home --home-dir /var/lib/agentmesh agentmesh
sudo mkdir -p /srv/repos && sudo chown agentmesh: /srv/repos
```

Windows 上构建步骤没有任何区别：`git clone`、`npm ci`、`npm run build`，然后 `node dist\cli.js`。
如果这台机器还有人用，给 daemon 一个专用本地账号而不是 `SYSTEM`——daemon 继承该账号的文件权限，
它拉起的每个 agent 也一样继承。

### agent：pi

```bash
npm install -g @earendil-works/pi-coding-agent   # 提供 `pi` 这个可执行文件
sudo -u agentmesh -H pi                          # 以 daemon 的身份登录一次
```

`acpx` 用 `npx pi-acp` 拉起它，`pi-acp` 再去驱动那个可执行文件。所以有两个前提必须在第一个任务
之前就成立：`pi` 在 **daemon 账号的 `PATH`** 里，并且是用 **那个账号** 登录的——凭据在 `~/.pi` 下，
你用自己的用户装好、登录好的 agent，对以 `agentmesh` 身份运行的 daemon 是不存在的。
这种失败在第一轮对话里以 agent 报错的形式出现，不会在启动时暴露。

### 证书

非回环地址不带 TLS 会被拒绝启动（`insecure_bind`），所以没有“先跳过证书试一下”这条路。

```bash
bash deploy/certs/make-certs.sh --out /etc/agentmesh/certs \
  --san "DNS:worker.internal,IP:10.0.0.12"
```

实践中出问题的总是 SAN：A 用 `https://10.0.0.12:8790` 连，那证书里没有 `IP:10.0.0.12` 就白签。
把 A 可能用到的**所有**名字与地址都写进去。脚本产出：

| 文件 | 谁需要 | 用途 |
|---|---|---|
| `ca.pem` | 两台 | 信任根；A 用它验证 B |
| `ca-key.pem` | 运行时谁都不需要 | **能签发受信任证书——请离线保存** |
| `server.pem` / `server-key.pem` | B | daemon 的身份 |
| `client.pem` / `client-key.pem` | A | 只在 B 开双向 TLS 时用 |

不用 mTLS 就加 `--no-client`，跳过客户端证书。有效期默认 825 天，用
`openssl x509 -in server.pem -noout -enddate` 查。

### 配置

B 机的 `agentmesh.yaml`，`daemon:` 块里的每个键：

```yaml
workdir: /var/lib/agentmesh        # 任务库、worktree、暂存的交接补丁都在这

profiles:
  - name: pi                       # A 侧 remoteProfile 要写的名字
    driver: acpx
    agent: pi                      # acpx 内置名 -> `npx pi-acp`
    cwd: /srv/repos                # 该 profile 在 B 上的默认工作目录
    worktree: true                 # 每个任务隔离在独立 git worktree（可选）

daemon:
  host: 0.0.0.0                    # 默认 127.0.0.1——必须让 A 能连上
  port: 8790                       # 默认 8787
  tokenEnv: AGENTMESH_DAEMON_TOKEN # 环境变量名，不是密钥本身
  allowCwd: [/srv/repos]           # 必填：远程任务不能跑出这些根
  exposeProfiles: [pi]             # 可选；默认暴露所有非 remote 的 profile
  orphanGraceMs: 30000             # 默认 0——掉线后让任务多活这么久
  tls:
    cert: /etc/agentmesh/certs/server.pem
    key: /etc/agentmesh/certs/server-key.pem
    ca: /etc/agentmesh/certs/ca.pem      # 一旦填了，就要求双向 TLS
  auditPath: /var/lib/agentmesh/daemon-audit.ndjson   # 默认 <workdir>/daemon-audit.ndjson
  auditMaxBytes: 10485760          # 默认 10 MiB；0 = 不轮转
  auditKeep: 5                     # 默认保留 5 个归档
```

几个承重键为什么存在：

- **`allowCwd` 是必填项，不是可选优化。** 空着或没有这个键，所有远程任务都会被拒
  （`cwd_not_whitelisted`）。它挡住的是“master 让 agent 在你家目录里跑”这件事；比较按路径段做，
  所以 `/srv/repos_evil` 不会被当成 `/srv/repos`。
- **`exposeProfiles`** 收窄远程调用方能看到什么。不写的话，daemon 会暴露所有非 `driver: remote`
  的 profile——包括那些能伸到别的机器上的。
- **`orphanGraceMs`** 决定“网络抖一下”意味着什么。默认 `0`：socket 一关就取消任务，诚实但浪费；
  给个宽限窗口，A 就能用 `resume: true` 重连并把同一轮跑完。
- **`tls.ca`** 就是双向 TLS 的开关。填了之后，daemon 在握手阶段（解析任何请求之前）就要求由该 CA
  签发的客户端证书。
- **`workdir`** 是 B 的状态，不是 A 的：任务库、worktree、暂存补丁的 `<workdir>/handoffs/` 都在这里。
  它不必位于 `allowCwd` 之内。

### token

```bash
printf 'AGENTMESH_DAEMON_TOKEN=%s\n' "$(openssl rand -hex 32)" \
  | sudo tee /etc/agentmesh/worker.env >/dev/null
sudo chmod 600 /etc/agentmesh/worker.env
```

同一个值要放进 A 的环境。`tokenEnv` 还支持用逗号写多个变量名，而每个变量的值又能用逗号放多个
token——这正是下文“token 轮换”能做到零停机的原因。token 集合为空时 daemon 拒绝启动
（`no_token`），而不是以“谁都能连”的状态起来。

Windows：`setx /M AGENTMESH_DAEMON_TOKEN "<hex>"` 设成机器级变量，计划任务能读到；启动包装脚本发现
它没设会直接退出。

### 启动

```bash
# 前台跑，第一次就该这么跑
sudo -u agentmesh env $(sudo cat /etc/agentmesh/worker.env) \
  node /srv/agentmesh/dist/cli.js daemon --config /etc/agentmesh/agentmesh.yaml
# [agentmesh] worker daemon listening on https://0.0.0.0:8790 (https, profiles: pi)
```

一次性测试时命令行参数可以覆盖配置：`--host`、`--port`、`--token-env`、`--tls-cert`、`--tls-key`、
`--tls-ca`、`--orphan-grace-ms`、`--allow-insecure`（共享网络上永远别用——那等于把 agent 控制器
明文暴露）。

信号：`SIGINT`/`SIGTERM` 干净退出（刷盘并关闭审计流）；`SIGHUP` 重新从环境读一遍 token。

两个探针，故意的差别：

```bash
curl -k https://10.0.0.12:8790/healthz                  # 免鉴权：{ok, daemonId, protocol}
curl -k -H "Authorization: Bearer $TOK" https://10.0.0.12:8790/profiles
# {"daemonId":"daemon-…","profiles":["pi"]}
```

## A 机：master

A 不需要入站端口、不需要 worker agent、也不需要 daemon。它需要同一份构建、一个指向 B 的 profile，
以及——如果你想让它有脑子——Claude Code。

```bash
git clone https://github.com/simtfer/agentmesh.git && cd agentmesh
npm ci && npm run build
export AGENTMESH_REMOTE_TOKEN='<B 上那串 32 字节十六进制>'
```

```yaml
workdir: ./state

profiles:
  - name: worker-pi                # 你给这个 worker 起的名字，task_submit 时用
    driver: remote
    cwd: /srv/repos                # B 机上的路径——见下一节
    remote:
      endpoint: https://10.0.0.12:8790   # 这里写 https://，wss:// 会自动推导
      tokenEnv: AGENTMESH_REMOTE_TOKEN
      remoteProfile: pi            # B 上的 profile 名；不写则用本 profile 的名字
      ca: /etc/agentmesh/ca.pem    # 信任 B 的私有 CA
      cert: /etc/agentmesh/client.pem      # 仅当 B 开 mTLS 时需要
      key: /etc/agentmesh/client-key.pem
      connectTimeoutMs: 15000      # 默认 15000，WS 握手预算
      resume: true                 # 中途掉线自动重连续流
      reconnectAttempts: 3         # 默认 3
      reconnectDelayMs: 500        # 默认 500
```

两端的 `cert`/`key`/`ca` 都既接受文件路径，也接受内联 PEM。路径读不到时会立刻报
`tls_invalid`，而不是在另一台机器上表现成一个看不懂的握手失败。

两种驱动方式。

**用命令行**——A 上还没有 agent 时，这样就能先把链路验通：

```bash
node dist/cli.js dispatch --profile worker-pi --task "跑一遍测试"
```

**用 Claude Code**——这才是让 A 自己有判断力的形态。Claude Code 把 `dist/cli.js mcp` 当 stdio
server 拉起来，之后由它自己决定调哪些工具：

```json
{
  "mcpServers": {
    "agentmesh": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/ABS/PATH/agentmesh/dist/cli.js",
        "mcp",
        "--config",
        "/ABS/PATH/agentmesh/agentmesh.yaml"
      ],
      "env": { "AGENTMESH_REMOTE_TOKEN": "${AGENTMESH_REMOTE_TOKEN}" }
    }
  }
}
```

```bash
# 不写文件，注册到 user scope 的等价写法
claude mcp add --scope user --transport stdio agentmesh -- \
  node /ABS/PATH/agentmesh/dist/cli.js mcp --config /ABS/PATH/agentmesh/agentmesh.yaml
```

JSON 放在你运行 `claude` 的目录下的 `.mcp.json`（project scope，跟着目录走），或者让
`claude mcp add` 写到别处。然后在会话里说：*“让 B 上那个 pi worker 在 /srv/repos/api 里跑一遍测试，
把失败的修掉。”* 剩下的由 Claude Code 用 `task_submit` / `task_wait` 完成。

这个安排有三条性质值得先说清，因为“它停了”这类问题大多是它们引起的：

- **必须用绝对路径。** server 是从 Claude Code 自己的 cwd 拉起来的，`./dist/cli.js` 和
  `./agentmesh.yaml` 会静默指到别的地方去。
- **密钥不进文件。** 在 `.mcp.json` 里，`${AGENTMESH_REMOTE_TOKEN}` 由 Claude Code 从环境展开，所以在启动
  `claude` 的那个 shell 里 export（`~/.bashrc` 或 `setx`）。把 token 字面量写进 `.mcp.json`，
  就是写进了一个仓库。
- **server 是会话的子进程。** 退出 `claude`，持有 orchestrator 的那个进程也一起走：任务记录还在
  A 的 SQLite 里，但正在跑的那一轮不会接着跑。要活过会话的长任务，就让同一个 `mcp` server
  挂在长生命周期的客户端下面。

审批是唯一只能在常驻模式下走完的事。待审批项活在持有该任务的 orchestrator 进程里，第二个 CLI
进程没法回答它——对需要授权的任务用 `dispatch`，它会一直停在 `waiting`，直到任务超时（默认十分钟）
并以 `timed_out` 结束。Claude Code 用 `task_approve` 回答，因为提交它的就是同一个进程。

## `cwd` 的契约

这是双机部署里最常见的失败，而且它不是 bug。

远程 profile 上的 `cwd` 是**B 机上的路径**，哪怕它写在 A 的配置文件里。daemon 会解析它、拿
`daemon.allowCwd` 校验，然后才启动 worker：

| A 发的值 | B 的处理 |
|---|---|
| `cwd: /srv/repos`，而 B 的 `allowCwd: [/srv/repos]` | 在那里跑 |
| `cwd: /srv/repos`，而 B 的 `allowCwd: [/srv/work]` | 拒绝：`working directory not in whitelist: /srv/repos (cwd_not_whitelisted)` |
| 不写——用 A 自己的工作目录 | 一般会被拒，因为 A 的 `/home/me/proj` 在 B 上不存在 |
| `../repos` 或 `/srv/repos/../..` | 先解析再校验：逃不出根目录 |

结论：远程 profile 一定要显式写 `cwd`，写成 B 白名单内的路径。同一个任务可能落在两台机器上时，
就给两个 profile 各写一个 `cwd`，别指望一个字符串两边都对。

## 逐级验证

按顺序爬。每上一级就排除掉一半未知；在第 *n* 级失败，说明它下面各级都是好的。

| # | 验的是什么 | 命令 | 期望 |
|---|---|---|---|
| 1 | 链路通 | `curl -k https://<B>:8790/healthz` | `{"ok":true,…}`，不需要鉴权 |
| 2 | token 对 | `curl -k -H "Authorization: Bearer $TOK" https://<B>:8790/profiles` | 返回 profile 列表；不带头发 `401` |
| 3 | TLS 信任对 | 用 `driver: mock` 的 profile 跑一次 `dispatch` | `"status": "completed"` |
| 4 | agent 能跑 | 用真实的 `pi` profile 跑 `dispatch` | 得到真实回答，且 B 的审计日志出现 `submit_ok` |
| 5 | mTLS 生效 | 先不带 `remote.cert` 跑，再带上 | 第一次报 `alert certificate required`，第二次成功 |
| 6 | 掉线可恢复 | 跑到一半掐掉连接（`orphanGraceMs` > 0、`resume: true`） | 任务照样跑完；事件被重放而不是重复 |

第 1–5 级在本页写出来之前，已经在同一台机器上用私有 CA + TLS 端到端跑过（含 mTLS 开与关）；
第 6 级由 `test/remote.test.ts` 覆盖。诚实的边界见[验证到了哪一步](#验证到了哪一步)。

## 开机自启

Linux，用仓库里的 unit（它假定 `/srv/agentmesh` 和一个叫 `agentmesh` 的服务账号）：

```bash
sudo cp deploy/systemd/agentmesh-worker.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now agentmesh-worker
systemctl status agentmesh-worker
```

unit 里的 `ReadWritePaths` 必须同时覆盖 `workdir` **和**每个 `allowCwd` 根，否则 agent 写不进
它被雇来改的那个仓库。

Windows，不装额外软件：

```bat
setx /M AGENTMESH_DAEMON_TOKEN "<hex>"
schtasks /create /tn "agentmesh worker" /tr "C:\agentmesh\deploy\windows\run-worker.cmd" ^
         /sc onstart /ru SYSTEM /rl HIGHEST /f
schtasks /run /tn "agentmesh worker"
```

包装脚本把输出写到 `daemon.out.log` 且不轮转；真正需要轮转的、跟安全相关的是审计日志。
要连 stdout 一起轮转，就换 NSSM 或 WinSW。

启动顺序无所谓——A 是按需拨号——但 B 必须先起来，A 的第一个任务才会成功；B 没起时
`dispatch` 会直接报 `connection refused`，不会静默排队。

## 日常运维

**两份日志，轮转方式不同。** 审计日志（`daemon.auditPath`，NDJSON：鉴权、提交与判定、审批、
取消、重连、TLS 拒绝、token 重载）由进程内按大小轮转。stdout/stderr 只有启动与关闭提示，
归 systemd/journald 或运维自己管。

**重启语义。** agent 进程是 daemon 的子进程，所以重启 B 会结束正在跑的那一轮：任务记录还在 B 的库里，
但这一轮不会接着跑。没有宽限窗口时，优雅 `SIGTERM` 会在关 socket 的过程中把在跑任务结算成
`cancelled`；配了 `orphanGraceMs > 0` 时，记录会原样留着，因为那个窗口假设 daemon 还在。
硬杀则一律留在原地。无论哪种，daemon 重启后遇到非终态记录，master 都该把它当**未知**
（`queryRemoteTask`）并重新提交，而不是等一个永远不会来的结果。`orphanGraceMs` 是为
**掉线**准备的，不是为重启——它只在同一个 daemon 还活着时有用。重启 A 也不丢历史（库是 A 的
SQLite 文件），但它当时在跑的那些轮次随进程结束。

**token 轮换**（零停机）：

```bash
# 1. 把新密钥接在旧的后面，同一个变量，逗号分隔
AGENTMESH_DAEMON_TOKEN="<old>,<new>"
# 2. reload B，把 A 侧客户端切到 <new>，再用只剩 <new> 的值 reload 一次
kill -HUP <daemon pid>        # 或：systemctl reload agentmesh-worker
```

reload 会拒绝空集合，所以打错字既不会让 daemon 变成免鉴权，也不会把你自己锁在外面。

**证书轮换**要重启：换上新的 `server.pem`/`server-key.pem`（A 侧是 `client.*`），重启，受影响的只是新连接。

**端口与防火墙。** 只需要一个方向：A → B 的 `daemon.port`。把来源地址钉死；token 与 mTLS 是纵深防御，
不是防火墙规则的替代品。Linux（`ufw`/`firewalld`）与 Windows（`New-NetFirewallRule`）的一行命令在
[`deploy.md`](./deploy.md#3-firewall)。

## 故障对照表

下表的报错文本是代码里真实会打出来的。

| 位置 | 报错 | 含义 | 处理 |
|---|---|---|---|
| B 启动 | `refusing to bind non-loopback host "0.0.0.0" without TLS`（`insecure_bind`） | 没配 `daemon.tls` | 配 cert/key |
| B 启动 | `daemon requires a bearer token …`（`no_token`） | `tokenEnv` 没写，或服务环境里那个变量是空的 | 把密钥放进 unit 的 `EnvironmentFile` |
| B 启动 | `EADDRINUSE` | 该端口已有 daemon 在跑 | 停掉，或改 `daemon.port` |
| B 启动 | `tls_invalid` | cert/key/ca 路径读不到，或不是 PEM | 修路径与权限 |
| B 运行 | `working directory not in whitelist: … (cwd_not_whitelisted)` | A 的 `cwd` 不在 `allowCwd` 里 | 两边对齐 |
| B 运行 | `profile_not_allowed` | `remoteProfile` 没被暴露 | 加进 `exposeProfiles` |
| B 审计 | `tls_reject` 带 `peer did not return a certificate` | 开了 mTLS，A 没带客户端证书 | 补 `remote.cert`/`remote.key` |
| A | 升级连接时 `401` | token 不一致 | 两端同一个密钥 |
| A | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | A 信任的 CA 不对 | `remote.ca` 指向 B 的 `ca.pem` |
| A | `ERR_TLS_CERT_ALTNAME_INVALID` | SAN 不覆盖 `endpoint` 拨号的名字 | 重新签发 |
| A | `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED` | B 开 mTLS，A 没证书 | 同 `tls_reject` 那行 |
| A | `connect ECONNREFUSED` | 没人监听，或被防火墙丢了 | 回到验证第 1 级 |
| A | 抖动后任务 `cancelled` | `orphanGraceMs: 0` 或 `resume: false` | 给宽限窗口 + 开 resume |
| A（Claude Code） | `claude mcp list` 里 server 显示失败 | stdio 命令一启动就退：相对路径、配置文件不在，或 Claude 的 `PATH` 里没有 `node` | 全用绝对路径；把同一条命令手动跑一遍看它的 stderr |
| A（Claude Code） | 工具在，但每个远程提交都 `401` | 会话环境里没有 `AGENTMESH_REMOTE_TOKEN` | 在启动 `claude` 的地方 export，或在 `env` 里写 `${AGENTMESH_REMOTE_TOKEN}` |

更多错误码：[`troubleshooting.md`](./troubleshooting.md)。想知道“谁试过什么”，先看审计日志——
拒绝记录会带对端地址，鉴权失败还会带所给 token 的 12 位十六进制指纹（永远不是 token 本身）。

## 安全清单

在 B 能让 A 以外的东西连上之前：

- [ ] `daemon.allowCwd` 只列 agent 真正可以碰的根——没有 `/`、没有 `$HOME`、没有“万物之父”目录
- [ ] TLS 开着；SAN 覆盖 A 拨的地址；`ca-key.pem` 不在 B 上
- [ ] 网络共享或 token 可能泄露时，开 mTLS
- [ ] token 在环境变量里、权限 0600，绝不进 `agentmesh.yaml` 或仓库
- [ ] 防火墙只放 A → `daemon.port`
- [ ] daemon 用专用账号跑，systemd 的 `ReadWritePaths` 与 `allowCwd` 一致
- [ ] 审计日志会轮转（`auditMaxBytes` > 0），而且放在你真的会看的地方
- [ ] 你接受这个爆炸半径：通过鉴权的调用方可以以该账号身份执行工具。把 token 当 SSH 私钥对待，它就是这个级别的东西

## 验证到了哪一步

明说，因为“能跑”从来不是一个断言：

- `npm run deploy:tls` 在**真实网卡**上（用本机 LAN 地址，不走回环）跑完整套，并且覆盖失败模式：
  master 信任错 CA、在可达网卡上明文绑定、mTLS 缺失或外来客户端证书。
- 本页的配置是照着实际执行验证过的——私有 CA + TLS、mTLS 开与关、白名单拒绝、错 token 拒绝——
  在 Windows 上、两个进程同机。
- master 这一侧是通过 Claude Code 接入的**同一个 stdio MCP 面**验证的（`npm run smoke` 用真实管道
  驱动它跑完整任务生命周期，含审批），另外也在同一台机器上对真实的 `pi` 与 `opencode` worker
  跑过（`npm run real`）。**没有**验证的是：用一次真正的 Claude Code 会话把整套跑通——上面那段
  接法是标准的 stdio MCP 配置，但在你亲眼看到 `claude mcp list` 报健康之前，请按“未验证”对待。
- **没有**覆盖的是：两台物理机器。DNS、路由、worker 的防火墙正是上面那份清单要解决的东西，
  也恰恰是实践中最先失败的部分。macOS 未验证。

逐项测试明细：[`verification.md`](./verification.md)。

## 接下来读什么

| | |
|---|---|
| [`quickstart.zh.md`](./quickstart.zh.md) | 本页的十五分钟版 |
| [`deploy.md`](./deploy.md) | CA、mTLS、防火墙、systemd、轮换，按运维顺序 |
| [`remote.md`](./remote.md) | daemon 做了什么，以及重连用的客户端 API |
| [`configuration.md`](./configuration.md) | `agentmesh.yaml` 每个键的参考 |
| [`troubleshooting.md`](./troubleshooting.md) | 全系统的错误码 |
