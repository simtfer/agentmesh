# 快速上手：两台机器，跑通一个任务

A 机当 master，B 机跑 worker daemon，把第一个委派任务端到端跑起来。Node 已装好的话，十五分钟。

```
A —— master                                   B —— worker
┌───────────────────────────┐   WSS :8790    ┌──────────────────────────────┐
│ node dist/cli.js dispatch │ ─────────────▶ │ agentmesh daemon（TLS）      │
│ driver: remote profile    │ ◀───────────── │ 本机 agent：opencode / mock  │
└───────────────────────────┘    任务事件     └──────────────────────────────┘
```

只有 worker 需要开入站端口，也只有 worker 跑编码 agent。master 从不接受连接，它主动外连并把事件流拉回来。

## 目录

- [0. 两台机器都要做的](#0-两台机器都要做的)
- [1. B 机：证书与配置](#1-b-机证书与配置)
- [2. B 机：启动 daemon](#2-b-机启动-daemon)
- [3. A 机：指向 B 并跑一个任务](#3-a-机指向-b-并跑一个任务)
- [4. 把 mock 换成真 agent](#4-把-mock-换成真-agent)
- [5. 跑不通时](#5-跑不通时)
- [下一步](#下一步)

## 0. 两台机器都要做的

```bash
git clone https://github.com/simtfer/agentmesh.git
cd agentmesh && npm ci && npm run build      # 产出 dist/cli.js
```

要求：**Node ≥ 22.13**；B 机还需要 `openssl`（Windows 上 Git Bash 自带）。下文命令都是
`node dist/cli.js …`；想直接敲 `agentmesh`，把仓库 `npm link` 一下即可。

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

## 4. 把 mock 换成真 agent

在 B 上替换 profile（daemon 启动时读配置，所以要重启）：

```yaml
profiles:
  - name: opencode
    driver: acpx
    agent: opencode          # B 上必须已安装并完成认证
    cwd: /srv/repos
```

在 A 上把 `remoteProfile` 改成 `opencode`。A 侧的 profile 名字随你起，`remoteProfile` 的值才是 B 上的名字。

```bash
node dist/cli.js dispatch --profile worker-opencode --task "加一个 /health 端点并跑测试"
```

要做真正的编排（异步、审批、多 worker），在 A 上起 `mcp` 并接到 OpenCode 或 Pi——那才是 master agent 对话的对象：
[`cli.md`](./cli.md)。

## 5. 跑不通时

| 现象 | 原因 | 处理 |
|---|---|---|
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | A 信任的 CA 不是签 B 证书的那张 | 把 `remote.ca` 指向 B 的 `ca.pem` |
| `ERR_TLS_CERT_ALTNAME_INVALID` | SAN 不包含 `endpoint` 里的名字 | 用匹配的 SAN 重新签发 |
| 升级连接时 `401` | 两端 token 不同，或 daemon 的环境里没有那个变量 | 同一个密钥，且用 daemon 真正读取的变量名 |
| `cwd_not_whitelisted` | `cwd` 没写，或不在 `daemon.allowCwd` 里 | 写成 B 侧、白名单内的路径 |
| `EADDRINUSE` | 那个端口已经有 daemon 在跑 | 停掉它，或改 `daemon.port` |
| `alert certificate required` | B 开了 mTLS，A 没带客户端证书 | 补 `remote.cert` / `remote.key` |
| 网络抖一下任务就 `cancelled` | B 没给宽限窗口 | 设 `daemon.orphanGraceMs` 并开 `resume: true` |

完整对照表（含原始报错文本）：[`troubleshooting.md`](./troubleshooting.md)、
[`deploy.md`](./deploy.md#7-troubleshooting)。

## 下一步

- 两侧每个配置键、按操作系统分的步骤、逐级验证与运维清单：[`two-host.zh.md`](./two-host.zh.md)
- CA、mTLS、防火墙、开机启动、轮换：[`deploy.md`](./deploy.md)
- daemon 到底做了什么：[`remote.md`](./remote.md)
