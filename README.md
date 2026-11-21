# OMP SSH Remote

SSH remote workspace execution for Oh My Pi. This repository contains only the OMP integration.

## Build and install

```sh
bun install --frozen-lockfile
bun run check
bun run build:worker:all
omp plugin link "$PWD/packages/omp"
```

The installed package path remains `packages/omp`; existing local links remain valid. Compiled workers are generated artifacts, not tracked in Git.

## Upgrading OMP

The plugin promises native parity for a fixed set of workspace tools (`bash` with jobs and services, `read`, `write`, `edit`, `grep`, `glob`, `lsp`, `eval`, `debug`, AST tools) plus approvals and the model-visible environment. New upstream features that act on the workspace are rejected while connected until they are deliberately supported. Every native behavior the plugin relies on is registered: source adaptations in `src/omp/sdk-contract.ts`, semantic assumptions in `scripts/sdk-semantic-contracts.ts`.

1. **Assess.** `bun run upgrade:assess <version>` downloads the target SDK into a temporary directory and reports adaptation anchors against it, every native file the plugin imports or names in a contract that changed or disappeared (with the reasons it matters), and the CHANGELOG's breaking changes since the supported version. It changes nothing. Read the listed diffs; an unchanged file needs no review. After the pins are bumped, pass `--from <old version>` to keep the old baseline.
2. **Pin.** Update the six exact `@oh-my-pi/*` pins in root `package.json`, the peer floor in `packages/omp/package.json`, and `SUPPORTED_SDK_VERSION` together; `bun install`; keep the lockfile.
3. **Adapt.** Fix what the assessment listed. Delete adaptations fixed upstream; update drifted anchors with their regression tests; never weaken a guard to pass. Bump `TOOL_RUNTIME_VERSION` in `src/protocol.ts` only when the wire contract changes — companion admission uses it, not the OMP version.
4. **Gate.** `bun run upgrade:gate` runs `check:sdk`, typecheck, build, tests, both worker builds, then the lifecycle smoke and native task acceptance on every host in the untracked `.omp/acceptance.json` (format in `scripts/upgrade-gate.ts`). Add `--lsp` when the assessment lists LSP or language-pack sources. Real-host steps drive `$OMP_BINARY` (default `omp`), which must report the pinned version; point it at an isolated install (`BUN_INSTALL=/tmp/omp-next bun add -g @oh-my-pi/pi-coding-agent@<version>`) to accept the candidate before replacing the global OMP.
5. Release only after the gate passes.

Other suites (`bun scripts/run-smoke.ts cache|capture|rich-output`, `scripts/run-connect-admission.ts`, `benchmark:omp`) are for changes in their own areas, not every upgrade.

## Documentation

- [English](packages/omp/README.md)
- [简体中文](packages/omp/README.zh-CN.md)

## Verification

```sh
REMOTE_ALIAS=<ssh-alias> REMOTE_CWD=<remote-path> bun run benchmark:omp
```

Each session and non-isolated subagent owns its own companion. Conversation and orchestration stay local. Remote worktrees remain explicitly unsupported.

[MIT](LICENSE)
