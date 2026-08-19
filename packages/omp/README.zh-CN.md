# OMP SSH Remote

简体中文 | [English](README.md)

OMP SSH Remote 将 Oh My Pi 控制面保留在本机，同时通过 SSH 在远端 Linux 主机的持久 companion 中执行有状态的 OMP 原生工作区工具。本 package 只适配 OMP；Pi Agent 使用独立的 [`../pi`](../pi/README.zh-CN.md) package。

## Runtime 边界

本机 OMP 继续负责 TUI、对话、模型凭据、session、Magic Context、`task`、`hub`、`todo`、browser/computer 等控制面工具。每个 OMP session 使用一个独立远端 companion，持有远端文件系统、前台进程、hashline snapshot、AST proposal、LSP client、eval kernel 和 debugger session。

远端原生工具：

`read`、`write`、`edit`、前台 `bash`、`grep`、`glob`、`lsp`、`ast_grep`、`ast_edit`、受限 `eval` 和 `debug`。

普通非隔离子代理继承连接配置，但各自使用独立 companion。`task isolated:true`、远端 async Bash 和 artifact transfer 尚不支持，并采用 fail-closed。

```mermaid
flowchart LR
  OMP[本机 OMP 17.3.3] --> Adapter[OMP package adapter]
  Adapter <--> SSH[持久有界 SSH NDJSON]
  SSH <--> Worker[远端 OMP companion]
  Worker --> Tools[原生 ToolSession: 文件、AST、LSP、eval、debug]
  Tools --> Worktree[远端工作区]
```

## 环境要求

- 本机 Linux 或 WSL，OMP 必须为 `17.3.3`，并安装 Bun `1.3+`、npm、tar、OpenSSH 和 SCP；
- 远端为 glibc Linux `x86_64` 或 `aarch64`；
- 公钥 SSH 可在 batch mode 下登录；
- 远端项目目录已存在；
- 远端需要安装项目所需的 language server 和 debug adapter，但不需要安装 Bun 或 OMP。

主机密钥使用严格校验。请通过正常的 OpenSSH `known_hosts` 信任主机，不要关闭 host checking。插件同时禁用 agent forwarding 和 SSH forwarding。

## 构建与安装

在仓库根目录执行：

```bash
bun install --frozen-lockfile
bun run build:omp
bun run build:worker:all
omp plugin link "$PWD/packages/omp"
```

package 必须包含：

```text
packages/omp/dist/extension.js
packages/omp/dist/worker-linux-x64
packages/omp/dist/worker-linux-x64.sha256
packages/omp/dist/worker-linux-arm64
packages/omp/dist/worker-linux-arm64.sha256
```

链接后重启 OMP。更新时执行 `git pull`，重新构建 extension 和 workers，再重启或 reload plugin。连接状态下 reload 会关闭该 session 的 companion，之后需要重新连接。

## 连接与操作

可以使用标准 `~/.ssh/config` alias 或 OMP `/ssh add` 记录：

```text
/remote-connect gpu-box /srv/project
/remote-status
/remote-exit
```

显式形式：

```text
/remote-connect user@example.com /srv/project --port 22 --identity ~/.ssh/id_ed25519
```

模型也可以通过 `remote_connect`、`remote_workspace_status` 和 `remote_exit` 执行相同生命周期。状态工具按需调用，报告进程内已知状态；它不会向每一轮注入 prompt，也不会主动 ping SSH。

连接时普通文件路径远端执行，内部 URI resource 留在本机。混合本机 URI 和远端路径的操作会被拒绝。已选择的连接失效后继续 fail-closed，只有显式 `/remote-exit` 才恢复本机执行。

## 部署与安全

adapter 探测远端平台和 home，选择 package 自带的对应 worker，校验本机 SHA-256 sidecar，上传到 UUID 临时路径，在远端复核 SHA-256 后原子启用到：

```text
~/.cache/omp-ssh-remote/17.3.3/<sha256>/worker-linux-<arch>
```

协议 frame 上限为 16 MiB，部署 stdout/stderr 上限为 1 MiB。SSH 使用 batch mode、严格 host checking、`ForwardAgent=no` 和 `ClearAllForwardings=yes`。transport 断开时所有 pending call 报错，不会改为本机重试。前台子进程会收到取消；显式使用 `nohup` 或 `setsid` 脱离的命令属于不受管理的远端进程，断连后可能继续运行。

## 已验证性能

2026 年 8 月在 Linux x86_64 试验主机、缓存 worker 和持久 SSH ControlMaster 条件下：

| 操作 | 结果 |
| --- | --- |
| 缓存部署探测 | `72.17 ms` |
| companion 初始化 | `1487.46 ms` |
| read p50 / p95 | `18.01 / 34.36 ms` |
| 前台 Bash p50 / p95 | `16.23 / 134.45 ms` |
| LSP status p50 / p95 | `20.05 / 38.11 ms` |

x64 worker 首次上传耗时 `32.7 s`；缓存连接不再传输 worker。数据用于验收，不代表与网络无关的性能保证。

## 限制

- 仅支持 Linux glibc x86_64 和 ARM64；
- 仅支持 OMP `17.3.3`；
- 不支持 async Bash / 本机 `hub` job bridge；
- 不支持远端 isolated worktree；
- 不支持远端到本机 artifact bridge；
- 单个输出 frame 不能超过 16 MiB；
- browser、desktop、模型凭据、memory 和本机 session 控制面不进入远端。
