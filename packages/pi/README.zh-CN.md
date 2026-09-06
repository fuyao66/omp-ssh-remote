# Pi SSH Remote

简体中文 | [English](README.md)

Pi core 加独立、可插拔的工作区插件 adapters。对话、模型请求、凭据、记忆和 UI 留在本地；远端工作区扩展宿主执行选中的工具、执行钩子和已准入插件服务。OMP 是独立且不变的运行时。

## 执行边界

- `RuntimeAssembly` 描述已核验来源的完整组件能力、有效配置、工具归属与 schema。模型当前 active tools 是独立权限过滤，不决定运行组件身份。
- `PiWorkspaceBinding` 管理 local/connecting/remote/unavailable/closing 状态。切换后旧工作区的工具和补全结果被拒绝。
- 插件 integration 将工具、命令和 UI 查询接入同一个 binding。不会拦截或沙箱化任意插件直接调用的 Node 文件/进程 API。
- companion 加载真实 Pi 工具与选中的插件 factory，核验实际工具来源，报告自己的 schema 与配置。未知或不兼容组件 fail-closed。
- 无模型宿主驱动 `session_start`、`tool_call`、`tool_execution_start/update/end`、`tool_result` 和 `session_shutdown`。命令改写、拦截、错误状态、流式输出和压缩都属于执行域；不伪造模型/provider 事件。混合型插件需要显式本地控制入口。
- 只有钩子、不注册工具的插件也能按包来源和配置显式准入；不是自动部署任意已安装插件。
- 版本与二进制校验和用于构建身份；组件契约、配置和 schema 决定兼容性。

## 支持组件

| 组件 | 范围 |
| --- | --- |
| Pi core | 原生 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls` |
| `@ff-labs/pi-fff` | 默认 `fffind/ffgrep`、override 模式 `find/grep`、可选 multi-grep；原生渲染与提示元信息；远端 `@` 补全、health、rescan |
| `pi-rtk-optimizer` 0.9.0 | 工作区宿主执行真实上游改写和结果钩子；本地 `/rtk` 查询远端配置、可用性和压缩统计 |
| `@cortexkit/aft-pi` | 可选的既有工具 adapter 和独立制品；构建 core/FFF 不需要 AFT |
| Tintin subagents | 显式选择的继承 integration；普通远端 scope，不支持远端 worktree |

FFF 对象是 `@ff-labs/pi-fff`，不是另一个名为 `pi-fff` 的包。已验证的构建身份为 Pi 0.85.1、FFF 0.10.6。companion 使用 FFF 原生 Bun 后端；本地托管入口使用真实插件选择的后端。

## 构建

仓库根目录：

```bash
bun install --frozen-lockfile
bun run build:pi
bun scripts/compile-pi-worker.ts x64 --plugins=fff
bun scripts/compile-pi-worker.ts arm64 --plugins=fff
pi install "$PWD/packages/pi"
```

`--plugins=none` 构建无插件的 Pi core；可组合 `aft`、`fff`、`rtk`，例如 `--plugins=fff,rtk`。worker 可运行其内嵌组件的子集。缺失组件或执行钩子能力不兼容时拒绝握手，不回退本地。

FFF 平台共享库内嵌到独立 worker，不在运行时下载。交叉编译需要对应的 `@ff-labs/fff-bin-linux-<arch>-gnu` 制品；包管理器跳过非本机架构包时，将对应 npm 包解压至 `vendor/fff-linux-<arch>-gnu/`。只有选择 AFT 才需要 AFT 制品。生成的 worker 不提交 Git。

## 安装托管 FFF

保留上游 npm 包，但禁用其直接扩展入口；显式按顺序加载 remote 与托管 FFF：

```json
{
  "packages": [
    { "source": "npm:@ff-labs/pi-fff", "extensions": [] }
  ],
  "extensions": [
    "/absolute/path/to/omp-ssh-remote/packages/pi/dist/pi-extension.js",
    "/absolute/path/to/omp-ssh-remote/packages/pi/dist/pi-fff-extension.js"
  ]
}
```

把托管入口统一放在顶层 `extensions` 数组，remote host 在前。不要同时把 remote 包列在 `packages`：Pi 0.85.1 会保留包发现的 host 的较低优先级，导致顶层 FFF/RTK 即使排在数组后面也先加载。删除重复的 package 配置项即可，不删除构建文件；也不要改成 `extensions: []`，否则会禁用同路径 host。上游 FFF/RTK npm 包继续安装，只禁用原始入口。

其他已有插件可以保留。不要同时加载原始 FFF 与托管 FFF factory。托管入口通过公开 ExtensionAPI facade 调用真实上游插件，不修改 node_modules、不重写搜索算法。原生工具定义、补全、health/rescan 回调被保留，连接远端前关闭本地 finder。未经托管的 FFF 会被拒绝远端激活，而不是静默查询本地。

修改配置后 `/reload` 或重启 Pi。连接中 reload 保留远端绑定，不启动本地 FFF finder；`/remote-exit` 关闭 companion，并重建本地插件生命周期。

## 可选托管 RTK

使用 `--plugins=fff,rtk` 或 `--plugins=rtk` 构建。保留 `pi-rtk-optimizer@0.9.0` 包，禁用其直接入口（`{"source":"npm:pi-rtk-optimizer","extensions":[]}`），再在 remote host 后追加 `/absolute/path/to/omp-ssh-remote/packages/pi/dist/pi-rtk-extension.js`。不能同时启用原始与托管 RTK 钩子。

worker 内嵌上游 JavaScript 和延迟加载的压缩器，不内嵌原生 `rtk` 可执行文件。命令改写需要 RTK 位于**远端 worker 的 PATH**。缺失时准确报告不可用；上游默认保护保留原命令，结果压缩仍可执行。本地 RTK 可用不能证明远端可用。

`/rtk show`、`config`、`path`、`verify`、`status`、`stats`、`clear-stats` 查询当前执行域。本地模式保留上游设置界面；远端修改配置需先退出，在本地设置后重连，以重新协商不可变装配。worker 使用私有临时 agent 目录，不覆盖远端用户的 Pi 配置。默认不压缩 `read`；只处理上游支持的 `bash/read/grep`，不自动处理任意 FFF 工具。不会向 RTK 传递主对话或模型凭据。


## 使用

```text
/remote-connect gpu-box /srv/project
/remote-status
/fff-health
/fff-rescan
/remote-exit
```

模型也能调用 `remote_connect`、`remote_workspace_status`、`remote_exit`。使用已显式信任的 OpenSSH alias 与公钥认证。强制 `StrictHostKeyChecking=yes`，不复制模型凭据。

FFF 模式、multi-grep、扫描选项按有效配置协商。数据库路径留在各自执行域。切换模式需先退出远端，在本地修改并按上游提示 reload，再连接；远端模式修改会拒绝执行，不会静默改变工具归属。断连时搜索与 `@` 补全不回退本地候选。

## 其他插件

Ask、Goal 控制、模型请求设置、Web 凭据和上下文管理通常留在本地，但不代表插件内部文件访问已经远端化：

- Brainstorm 直接导出总结文件仍写本地。
- Web Access 的本地媒体输入仍属于本地。
- Magic Context 项目身份与直接 Git/文件检查仍跟随本地会话。
- 项目级模型/插件配置默认仍是本地配置。

以上是明确边界，不是整套插件完全兼容的声明。不能把远端文件路径交给未适配本地插件并假设 SSH 会接管。

## 可选继承

普通 `pi-extension.js` 不占用或发布进程级 subagent 环境状态。需要 Tintin 时，root 改用 `pi-tintin-extension.js`，受限 child 也显式加载该入口。继承后端由参数注入，与默认工作区绑定分开。不支持远端 worktree 隔离。

## 验证

```bash
bun run typecheck
bun test
REMOTE_TARGET=<ssh-alias> REMOTE_CWD=<remote-project> bun scripts/smoke-pi-fff.ts
PI_WORKSPACE_RTK=1 REMOTE_TARGET=<ssh-alias> REMOTE_CWD=<remote-project> bun scripts/smoke-pi-fff.ts
```

FFF smoke 验证同相对路径的不同本地/远端内容、远端 hostname、原生 renderer、health/rescan、连接中 reload、补全、强制断开 transport 后搜索与补全 fail-closed，以及退出恢复本地。ARM64 构建成功不等于在真实 ARM64 主机验收通过。
RTK 分支核验远端输出压缩、统计和控制服务；原生可执行文件存在时，对比自动改写、显式 RTK 和原始透传结果。`PI_RTK_REQUIRE_BINARY=1` 强制验收原生命令分支。搜索/RTK 已在 x64 与 ARM64 实机执行验收。官方 RTK 0.48.0 ARM64 二进制要求 glibc 2.39；旧系统需要兼容构建，不应为此升级系统 glibc。

原生工具使用远端用户权限，不是沙箱。协议帧有上限，取消是协作式的。脱离进程的命令不是托管持久任务；无自动重连/重放，无远端 worktree。
