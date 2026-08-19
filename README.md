# Remote Workspace Plugins

[简体中文](README.zh-CN.md) | English

This repository contains two independently installable SSH remote-workspace plugins. They share bounded SSH transport, strict host verification, content-addressed deployment, cancellation, and fail-closed routing. Their host runtimes, package manifests, companion binaries, and lifecycle rules are separate.

| Package | Host | Remote runtime | Documentation |
| --- | --- | --- | --- |
| `packages/omp` | Oh My Pi `17.3.3` | OMP native `ToolSession`, 11 workspace tools | [OMP SSH Remote](packages/omp/README.md) |
| `packages/pi` | Pi Agent `0.84.2` | Headless Pi + AFT `0.51.2`, 19 tools | [Pi SSH Remote](packages/pi/README.md) |

Do not install the repository root. Build from the root, then link only the package for the host you use:

```bash
bun install --frozen-lockfile
bun run build
bun run build:worker:all
bun run build:pi-worker:all
```

OMP:

```bash
omp plugin link "$PWD/packages/omp"
```

Pi Agent:

```bash
pi install "$PWD/packages/pi"
```

Both packages provide `/remote-connect`, `/remote-status`, `/remote-exit`, plus model-callable `remote_connect`, `remote_workspace_status`, and `remote_exit` tools. See the package README before installation; the Pi package has an explicit extension-order requirement because Pi resolves duplicate tools first-wins.

## Repository Layout

```text
packages/omp/   OMP-only manifest, docs, extension, and OMP workers
packages/pi/    Pi-only manifest, docs, extension, Pi+AFT workers, and AFT binaries
src/            shared transport plus separate OMP and Pi adapters/runtimes
scripts/        host-specific builds, smokes, and benchmarks
test/           shared-core and host-specific contracts
```

## Development Verification

```bash
bun run check
REMOTE_ALIAS=<ssh-alias> REMOTE_CWD=<remote-path> bun run benchmark:omp
REMOTE_ALIAS=<ssh-alias> REMOTE_CWD=<remote-path> bun run benchmark:pi
```

Workers are large generated artifacts and are ignored by Git. Source installation requires building the worker binaries locally before linking the package.

## License

[MIT](LICENSE)
