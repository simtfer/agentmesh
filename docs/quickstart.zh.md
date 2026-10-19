# 快速上手：两台机器，跑通一个任务

A 机当 master，B 机跑 worker daemon，把第一个委派任务端到端跑起来。Node 已装好的话，十五分钟。

全文的固定场景：**A 跑 Claude Code**，通过 MCP 指挥整个网格；**B 跑 pi**，真正动手改代码。
换任何别的组合，配置方式完全一样（角色由配置决定），但写死一对具体角色比写 `agent A` / `agent B` 好读。

```
A —— master                                    B —— worker
┌──────────────────────────────┐  WSS :8790    ┌──────────────────────────────┐
│ Claude Code                  │ ────────────▶ │ agentmesh daemon（TLS）      │
│   └── node dist/cli.js mcp   │ ◀──────────── │ 本机 agent：pi（经 acpx）    │
└──────────────────────────────┘    任务事件    └──────────────────────────────┘
```

只有 worker 需要开入站端口，也只有 worker 跑编码 agent。master 从不接受连接，它主动外连并把事件流拉回来。

## 目录

- [0. 两台机器都要做的](#0-两台机器都要做的)
- [1. B 机：证书与配置](#1-b-机证书与配置)
- [2. B 机：启动 daemon](#2-b-机启动-daemon)
- [3. A 机：指向 B 并跑一个任务](#3-a-机指向-b-并跑一个任务)
- [4. 把 mock 换成真的 pi agent](#4-把-mock-换成真的-pi-agent)
- [5. A 机：接上 Claude Code](#5-a-机接上-claude-code)
- [6. 跑不通时](#6-跑不通时)
- [下一步](#下一步)

## 0. 两台机器都要做的

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh && npm ci && npm run build      # 产出 dist/cli.js
```

要求：**Node ≥ 22.13**；B 机还需要 `openssl`（Windows 上 Git Bash 自带）。下文命令都是
`node dist/cli.js …`；想直接敲 `agentmesh`，把仓库 `npm link` 一下即可。

另外两样东西放到后面几步再装，这样这一步不会因为它们而失败：**A 上的 Claude Code**（第 5 步）
和 **B 上的 pi**（第 4 步）。在那之前，两侧都不需要任何 agent。

目前还没发布到 npm，所以“安装”就是在两台机器上各 clone 一份。两边版本要一致：线上协议是有版本号的，
不匹配时会在真正出问题的地方被拒（v1 的 daemon 不会悄悄丢掉交接产物，而是在握手里直接拒绝）。

## 1. B 机：证书与配置

非回环地址不带 TLS 是起不来的，所以先生成一套私有 CA。**SAN 必须覆盖 A 实际拨号用的名字**——
用 IP 连就得有 `IP:…`，用域名连就得有 `DNS:…`：

```bash
bash deploy/certs/make-certs.sh --out ./certs --san "DNS:worker.internal,IP:10.0.0.12"
```

它会写出 `ca.pem`、`server.pem/key.pem`，以及给双向 TLS 用的 `client.pem/key.pem`。
`ca-key.pem` 尽量别留在 worker 上——谁拿到它，谁就能签发这个 daemon 会信任的证书。

B 机的 `agentmesh.yaml`——先上一个 mock profile，这样这一步失败就一定是网络问题，而不是 agent 问题：

```yaml
workdir: ./state

profiles:
  - name: echo
    driver: mock
    mock: { reply: "pong from B", delayMs: 5 }

daemon:
  host: 0.0.0.0
  port: 8790
  tokenEnv: AGENTMESH_DAEMON_TOKEN     # 这里写变量名，密钥值留在环境变量里
  allowCwd: [/srv/repos]               # 必填：远程任务不能跑到这个根之外
  tls:
    cert: ./certs/server.pem
    key: ./certs/server-key.pem
  auditPath: ./state/daemon-audit.ndjson
```

B 机是 Windows 也一样，只是换成 Windows 路径（`C:/agentmesh/state`——正斜杠可用，也省掉 YAML 转义）。

## 2. B 机：启动 daemon

```bash
export AGENTMESH_DAEMON_TOKEN="$(openssl rand -hex 32)"   # 记下来，A 机要用同一个值
node dist/cli.js daemon --config agentmesh.yaml
# [agentmesh] worker daemon listening on https://0.0.0.0:8790 (https, profiles: echo)
```

先确认它活着，再去动 master。在 A 机（或 B 机本机）执行：

```bash
curl -k https://10.0.0.12:8790/healthz
# {"ok":true,"daemonId":"daemon-…","protocol":2}
```

> 这里故意用 `-k`：Windows 自带的 `curl` 走 Schannel，会忽略 `--cacert`，无法用你的私有 CA 建链。
> curl 用 OpenSSL 的平台上，`--cacert ./certs/ca.pem` 能正常校验。

`/healthz` 不需要鉴权，也不返回任何数据。其余端点都要 `Authorization: Bearer <token>`。

## 3. A 机：指向 B 并跑一个任务

```bash
export AGENTMESH_REMOTE_TOKEN='<同一个 32 字节十六进制>'    # 同一个密钥，变量名可以不同
```

A 机的 `agentmesh.yaml`：

```yaml
workdir: ./state

profiles:
  - name: worker-echo
    driver: remote
    cwd: /srv/repos                    # 这是 B 机上的路径——见下方说明
    remote:
      endpoint: https://10.0.0.12:8790
      tokenEnv: AGENTMESH_REMOTE_TOKEN
      remoteProfile: echo              # 在 B 上跑哪个 profile
      ca: ./certs/ca.pem               # 信任那张私有 CA
      # cert: ./certs/client.pem       # B 开了 mTLS 就把这两行解开
      # key:  ./certs/client-key.pem
      resume: true                     # 中途掉线时自动重连续流
```

同步跑一个任务：

```bash
node dist/cli.js dispatch --profile worker-echo --task "hello from A"
```

```json
{
  "taskId": "7e199d7b-…",
  "profile": "worker-echo",
  "status": "completed",
  "text": "pong from machine B",
  "cwd": "/srv/repos"
}
```

**`cwd` 这个坑。** 远程 profile 上的 `cwd` 是**在 B 上解释**的：它必须是 B 上真实存在、且在
`daemon.allowCwd` 里的路径。不写的话默认用 master 自己的工作目录，那在对端几乎永远不成立，
会被拒成 `cwd_not_whitelisted`。所以显式写成 B 的路径。

## 4. 把 mock 换成真的 pi agent

先在 B 上装好并登录 pi。`acpx` 是用 `npx pi-acp` 拉起它的，而 `pi-acp` 又需要 `PATH` 上有 `pi`：

```bash
npm install -g @earendil-works/pi-coding-agent
pi                       # 交互式登录一次，凭据落在 ~/.pi
```

然后在 B 上替换 profile（daemon 启动时读配置，所以要重启）：

```yaml
profiles:
  - name: pi
    driver: acpx
    agent: pi                # acpx 内置名 -> `npx pi-acp`
    cwd: /srv/repos
```

`pi` 没装或没登录时，失败发生在第一轮对话里，而不是 daemon 启动时——daemon 只在有任务时才拉它。

回到 A，改第 3 步那个 profile：名字改成 `worker-pi`，并指向刚建的这个（`remoteProfile: pi`）。
A 侧名字随你起，`remoteProfile` 的值才是 B 上的名字。

```bash
node dist/cli.js dispatch --profile worker-pi --task "加一个 /health 端点并跑测试"
```

这一条就验证了整条链路：A 的 orchestrator → TLS → B 的 daemon → acpx → 在 `/srv/repos` 里干活的 pi。

## 5. A 机：接上 Claude Code

第 4 步是 A 用命令行直接戳 B，A 上并没有 agent。agentmesh 真正想要的是另一种形态：
由 A 上的 Claude Code 决定派什么活。

把 MCP server 注册给 Claude Code——在跑 `claude` 的目录放一个 `.mcp.json`，或者用
`claude mcp add` 注册到别的 scope：

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
# 等价的一行命令，user scope
claude mcp add --scope user --transport stdio agentmesh -- \
  node /ABS/PATH/agentmesh/dist/cli.js mcp --config /ABS/PATH/agentmesh/agentmesh.yaml
```

关于这段配置，两件要说清的事：

- **只能用绝对路径。** Claude Code 是在自己的 cwd 里拉起这个命令的，`./dist/cli.js` 和
  `./agentmesh.yaml` 会解析到别的地方去。用 `claude mcp list` 检查：一启动就退出的 server 会显示为失败。
- **`${AGENTMESH_REMOTE_TOKEN}` 由 Claude Code 展开**（在 `.mcp.json` 里），所以密钥留在你的 shell 里
  （起 `claude` 之前 `export AGENTMESH_REMOTE_TOKEN='<hex>'`），不会落到文件里。

然后就像平常一样跟它说：

> 让 B 上那个 pi worker 在 `/srv/repos/api` 里加一个 `/health` 端点，并跑它的测试。

Claude Code 会调 `task_submit`、跟任务事件，最后把 worker 的结果汇报给你。想要异步形态就直说
（“先起任务，完了告诉我”），它就会用 `task_wait` / `task_result`。

> MCP server 是 **Claude Code 会话的子进程**：会话在它在，会话关它关。退出 `claude` 时还在跑的任务
> 会失去持有它的那个进程（记录还在，这一轮不会再有结果）。长任务就等它跑完，或者让同一个 `mcp`
> server 挂在长生命周期的客户端下面。

## 6. 跑不通时

| 现象 | 原因 | 处理 |
|---|---|---|
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | A 信任的 CA 不是签 B 证书的那张 | 把 `remote.ca` 指向 B 的 `ca.pem` |
| `ERR_TLS_CERT_ALTNAME_INVALID` | SAN 不包含 `endpoint` 里的名字 | 用匹配的 SAN 重新签发 |
| 升级连接时 `401` | 两端 token 不同，或 daemon 的环境里没有那个变量 | 同一个密钥，且用 daemon 真正读取的变量名 |
| `cwd_not_whitelisted` | `cwd` 没写，或不在 `daemon.allowCwd` 里 | 写成 B 侧、白名单内的路径 |
| `EADDRINUSE` | 那个端口已经有 daemon 在跑 | 停掉它，或改 `daemon.port` |
| `alert certificate required` | B 开了 mTLS，A 没带客户端证书 | 补 `remote.cert` / `remote.key` |
| 网络抖一下任务就 `cancelled` | B 没给宽限窗口 | 设 `daemon.orphanGraceMs` 并开 `resume: true` |
| `claude mcp list` 里 agentmesh 显示失败 | 用了相对路径，或配置文件不在那 | `dist/cli.js` 与 `agentmesh.yaml` 都写绝对路径 |
| Claude Code 说没有 agentmesh 的工具 | 这个会话里 server 没起来 | 在带 `.mcp.json` 的目录里重启 `claude`，并批准该 server |

完整对照表（含原始报错文本）：[`troubleshooting.md`](./troubleshooting.md)、
[`deploy.md`](./deploy.md#7-troubleshooting)。

## 下一步

- 两侧每个配置键、按操作系统分的步骤、逐级验证与运维清单：[`two-host.zh.md`](./two-host.zh.md)
- CA、mTLS、防火墙、开机启动、轮换：[`deploy.md`](./deploy.md)
- 换成别的 master（OpenCode、Pi）以及全部 CLI 命令：[`cli.md`](./cli.md)
- daemon 到底做了什么：[`remote.md`](./remote.md)
