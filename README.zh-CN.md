# OMP SSH Remote

本仓库只维护 Oh My Pi 的 SSH 远端工作区插件。Pi 实现已拆到相邻的独立仓库 `pi-ssh-remote`，两个仓库分别维护依赖、传输源码、构建和测试，不互相依赖。

## 构建与安装

```sh
bun install --frozen-lockfile
bun run check
bun run build:worker:all
omp plugin link "$PWD/packages/omp"
```

保留 `packages/omp` 安装路径，已有本机软链不变。worker 是生成文件，不提交 Git。

[完整使用说明](packages/omp/README.zh-CN.md) · [English](README.md)

每个 session 和普通子代理使用独立 companion；对话、模型调用和协调留在本机。隔离远端 worktree 继续明确拒绝。

[MIT](LICENSE)
