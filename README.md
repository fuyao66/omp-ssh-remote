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

The plugin promises native parity for a fixed set of workspace tools (`bash` with jobs and services, `read`, `write`, `edit`, `grep`, `glob`, `lsp`, `eval`, `debug`, AST tools) plus approvals and the model-visible environment. New upstream features that act on the workspace are rejected while connected until they are deliberately supported. Every native behavior the plugin relies on is registered: source adaptations in `src/omp/sdk-contract.ts`, semantic assumptions in `scripts/sdk-semantic-contracts.ts`. Each semantic assumption names the test that executes it; `review` marks the part a test cannot execute. Connect refuses a host OMP whose version differs from `SUPPORTED_SDK_VERSION`.

Start from a clean `main` and run `bun run upgrade <version>`. It creates `upgrade/omp-<version>` in a temporary Git worktree and installs the candidate OMP in an isolated Bun prefix. In that worktree it updates all six SDK pins, the plugin peer floor and `SUPPORTED_SDK_VERSION`, installs from the updated lockfile, and runs the assessment and release gate. The main checkout and live plugin artifacts are untouched until release.

Configure the release hosts in your untracked `.omp/acceptance.json` (see the example in `scripts/upgrade-gate.ts`). The release gate requires both `arch: "x64"` (CohortX) and `arch: "arm64"` (910B). It runs the LSP matrix and the compiled worker smoke, with C/C++ acceptance on hosts that set `cppEnv` (at least one required). The upgrade copies the host config and prepared `*-lsp-linux-*` archives and manifests from `packages/omp/dist` into the worktree.

Automatic release requires a passing gate, a diff limited to the pins, lockfile and version metadata, no failed anchors or missing native files, a changelog with no breaking changes, a compatible Bun version, and no changed native files covered by a contract marked `review`. The gate also rejects unclassified changes to the native execution-surface snapshot. Only then does the command bump the plugin patch version, rebuild and verify plugin discovery in a fresh RPC process without a model turn. It commits the upgrade, fast-forwards `main`, rebuilds the linked checkout, pushes, installs global OMP, and verifies the global plugin link and discovery. These steps are not one transaction: if the global install fails after the push, the plugin refuses to connect until the host version matches again, and the report gives the recovery steps.

If the command stops, read `.cache/upgrade-<version>.md` for the blockers and the retained worktree and install paths. When the only blockers are `review` notes, read the named upstream diffs; if they leave the plugin's assumptions intact, rerun with `--reviewed`. That flag waives only `review` notes, lists them in the report and the release commit, and still requires every other condition. Work in that checkout: inspect the assessment (`bun run upgrade:assess <version> --from <old>`), fix drift without weakening guards, classify changed execution surfaces, and rerun `OMP_BINARY=<candidate-omp> bun run upgrade:gate --release` before releasing manually. Change `TOOL_RUNTIME_VERSION` only when the companion wire contract changes.

`bun run upgrade <version> --dry-run` stops after eligibility checks, before any release or global changes. Add `--skip-gate` only to exercise the workflow locally: skipping the gate is itself a release blocker. `bun run upgrade:self-test` tests the eligibility rules without touching Git, SSH or the global install.

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
