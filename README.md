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

The build-time SDK contract lives in `src/omp/sdk-contract.ts`: one supported version and a registry naming every source adaptation, upstream module, purpose, and exact anchor count. Run `bun run check:sdk` separately from `check` to validate installed sources and all SDK imports without compiling a worker.

1. Update all six exact `@oh-my-pi/*` dependency pins in root `package.json`, the peer floor in `packages/omp/package.json`, and `SUPPORTED_SDK_VERSION` together.
2. Run `bun install` and retain the updated lockfile.
3. Run `bun run check:sdk`. Failures identify the adaptation and upstream path, unresolved import callers, or inconsistent versions.
4. Review each drifted adaptation against upstream behavior. Remove it from the registry and adapter plumbing if upstream fixes the underlying issue; otherwise update its anchors and regression tests. Re-run `bun run check:sdk` until clean; never weaken guards to bypass drift.
5. Review tool wire schemas and semantics. Bump `TOOL_RUNTIME_VERSION` in `src/omp/runtime-contract.ts` when compatibility changes: companion admission uses that runtime contract plus wire schemas, **not** the OMP package version.
6. Run `bun run check`, then `bun run build:worker:all`.
7. Run acceptance with an explicitly configured test host: `bun scripts/build-smoke.ts all`, then `bun scripts/run-smoke.ts <suite>` for `cache`, `cache-mc` (with installed MC compatibility), `lifecycle`, `capture`, `rich-output`, `lsp`, and `cpp-lsp`. Also run `bun scripts/smoke-remote.ts`, `bun scripts/smoke-extension.ts`, `bun scripts/smoke-subagent.ts`, and `bun run benchmark:omp`; see the package documentation for environment prerequisites.
8. Release only after both worker targets and applicable acceptance suites pass.

## Documentation

- [English](packages/omp/README.md)
- [简体中文](packages/omp/README.zh-CN.md)

## Verification

```sh
REMOTE_ALIAS=<ssh-alias> REMOTE_CWD=<remote-path> bun run benchmark:omp
```

Each session and non-isolated subagent owns its own companion. Conversation and orchestration stay local. Remote worktrees remain explicitly unsupported.

[MIT](LICENSE)
