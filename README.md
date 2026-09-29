# OMP SSH Remote

SSH remote workspace execution for Oh My Pi. This repository contains only the OMP integration.

Pi SSH Remote has been split into the independent sibling repository `pi-ssh-remote`; neither repository depends on the other. Shared transport code is independently maintained.

## Build and install

```sh
bun install --frozen-lockfile
bun run check
bun run build:worker:all
omp plugin link "$PWD/packages/omp"
```

The installed package path remains `packages/omp`; existing local links remain valid. Compiled workers are generated artifacts, not tracked in Git.

## Documentation

- [English](packages/omp/README.md)
- [简体中文](packages/omp/README.zh-CN.md)

## Verification

```sh
REMOTE_ALIAS=<ssh-alias> REMOTE_CWD=<remote-path> bun run benchmark:omp
```

Each session and non-isolated subagent owns its own companion. Conversation and orchestration stay local. Remote worktrees remain explicitly unsupported.

[MIT](LICENSE)
