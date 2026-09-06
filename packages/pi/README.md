# Pi SSH Remote

[简体中文](README.zh-CN.md) | English

Pi core plus independently pluggable workspace adapters. Conversation, model requests, credentials, memory and UI remain local; the remote workspace extension host executes selected tools, their execution hooks and admitted plugin services. OMP is a separate, unchanged runtime.

## Execution boundaries

- `RuntimeAssembly` describes the available source-verified component surface, effective plugin configuration, owners and schemas. The model's active-tool allowlist is a separate permission filter, not runtime identity.
- `PiWorkspaceBinding` owns local/connecting/remote/unavailable/closing transitions. Tool results and completion results from an obsolete workspace generation are rejected.
- Plugin integrations connect tools, commands and UI queries to the same binding. Arbitrary plugin calls to Node filesystem/process APIs are not intercepted or sandboxed.
- The companion loads real Pi tools and selected plugin factories, verifies actual tool provenance, and reports its own schemas and configuration. Unknown or incompatible components fail closed.
- The model-free host drives `session_start`, `tool_call`, `tool_execution_start/update/end`, `tool_result` and `session_shutdown`. Command mutation, blocking, result errors, streaming and compaction stay in the execution domain. Model/provider hooks are not synthesized; mixed plugins require an explicit local control entry.
- Hook-only plugins are explicitly admitted by verified package provenance and configuration even when they register no tools. This is not automatic deployment of arbitrary installed plugins.
- Versions and binary checksums identify reproducible builds; matching component contracts, configuration and schemas determine compatibility.

## Supported components

| Component | Scope |
| --- | --- |
| Pi core | Native `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls` |
| `@ff-labs/pi-fff` | Native `fffind`/`ffgrep`, or `find`/`grep` in override mode; optional multi-grep; native renderers and prompt metadata; remote `@` completion, health and rescan |
| `pi-rtk-optimizer` 0.9.0 | Actual upstream rewrite/result hooks in the workspace host; local `/rtk` controls query remote config, availability and compaction stats |
| `@cortexkit/aft-pi` | Optional existing tool adapter and separate native artifact; not required to build core or FFF workers |
| Tintin subagents | Explicit optional inheritance entry; ordinary remote scopes only, no remote worktrees |

The FFF adapter targets `@ff-labs/pi-fff`, not the unrelated `pi-fff` package. Validated build identities: Pi 0.85.1 and FFF 0.10.6. The companion uses FFF's native Bun backend; the local managed entry uses the backend selected by the real plugin.

## Build

From the repository root:

```bash
bun install --frozen-lockfile
bun run build:pi
bun scripts/compile-pi-worker.ts x64 --plugins=fff
bun scripts/compile-pi-worker.ts arm64 --plugins=fff
pi install "$PWD/packages/pi"
```

`--plugins=none` builds Pi core without plugin runtime imports. Combine `aft`, `fff` and `rtk`, for example `--plugins=fff,rtk`. A worker can run a subset of its bundled components. A missing requested component or incompatible workspace hook capability fails admission, never by local fallback.

FFF's platform shared library is embedded in the standalone worker, without runtime downloads. Cross-compilation requires the corresponding `@ff-labs/fff-bin-linux-<arch>-gnu` artifact. When a package manager skips an off-platform package, extract that npm package into `vendor/fff-linux-<arch>-gnu/` before building. AFT artifacts are only required when AFT is selected. Generated workers are ignored by Git.

## Install managed FFF

Keep the upstream npm package installed but disable its direct extension entry. Load the managed entry after Pi SSH Remote:

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

**Ordering matters:** keep managed entries together in the top-level `extensions` array, host first. Do not also list this remote package in `packages`: Pi 0.85.1 retains the package-discovered host's lower precedence, allowing top-level FFF/RTK entries to load first despite the explicit array order. Remove that redundant package entry (not the package files); do not replace it with `extensions: []`, which disables the same host path. Keep upstream FFF/RTK npm packages installed with their direct entries filtered.

The managed entry invokes the actual upstream factory through a public ExtensionAPI facade. It does not patch installed files or reimplement search. It preserves native tool definitions, captures native completion/health/rescan callbacks, and stops the local finder before remote activation. An unmanaged FFF installation is rejected for remote activation instead of silently searching local files.

Use `/reload` or restart Pi after changing extension configuration. During an active remote connection, reload retains the remote binding without starting a local FFF finder. `/remote-exit` closes the companion and reloads the local plugin lifecycle.

## Optional managed RTK

Build with `--plugins=fff,rtk` (or `--plugins=rtk`). Keep `pi-rtk-optimizer@0.9.0` installed with its direct extension disabled (`{"source":"npm:pi-rtk-optimizer","extensions":[]}`), then append `/absolute/path/to/omp-ssh-remote/packages/pi/dist/pi-rtk-extension.js` after the remote host entry. Do not enable both raw and managed RTK hooks.

The worker embeds upstream JavaScript, including its lazy compactor, not the native `rtk` executable. Install RTK in the **remote worker PATH** to enable rewriting. Missing RTK is reported accurately; upstream's default missing-binary guard leaves original commands unchanged, while result compaction still works. Local RTK availability is not evidence of remote availability.

`/rtk show`, `config`, `path`, `verify`, `status`, `stats` and `clear-stats` query the selected execution domain. The upstream settings UI remains available while local; remote configuration changes require exiting, changing settings locally and reconnecting to negotiate a new immutable assembly. Worker configuration uses a private temporary agent directory, not the remote user's Pi settings. Defaults keep `read` exact; RTK only compacts its supported names (`bash/read/grep`), not arbitrary FFF tools. No main conversation or model credentials are sent to RTK.


## Connect and operate

```text
/remote-connect gpu-box /srv/project
/remote-status
/fff-health
/fff-rescan
/remote-exit
```

The model can also use `remote_connect`, `remote_workspace_status`, and `remote_exit`. Use a pretrusted OpenSSH alias and public-key authentication. `StrictHostKeyChecking=yes` remains mandatory; credentials are not copied into the companion.

FFF mode, multi-grep and scan settings are negotiated as effective configuration. Database paths remain execution-domain-local. Change FFF mode while local, apply `/reload` when requested by upstream, then reconnect. Remote mode changes are rejected rather than silently changing tool ownership. On disconnect, searches and `@` completion never fall back to local candidates.

## Other plugins

Ask, goal control, model request settings, web credentials, and context management normally remain local. This does not automatically remoteize plugin-internal file access:

- Brainstorm's direct summary-file export remains local.
- Web Access local-media inputs remain local.
- Magic Context's project identity and direct Git/file checks remain tied to the local session context.
- Project-scoped model/plugin configuration is local unless explicitly integrated.

These are boundaries, not claims of full plugin compatibility. Do not pass remote file paths to an unadapted local plugin and assume SSH routing applies.

## Optional inheritance

Normal `pi-extension.js` does not claim or publish process-level subagent environment state. To opt into Tintin inheritance, load `pi-tintin-extension.js` instead of the normal entry for the root and explicitly for restricted children. Its injected inheritance backend is separate from the default workspace binding. Remote worktree isolation is unsupported.

## Verification

```bash
bun run typecheck
bun test
REMOTE_TARGET=<ssh-alias> REMOTE_CWD=<remote-project> bun scripts/smoke-pi-fff.ts
PI_WORKSPACE_RTK=1 REMOTE_TARGET=<ssh-alias> REMOTE_CWD=<remote-project> bun scripts/smoke-pi-fff.ts
```

The FFF smoke checks different local/remote contents at the same relative path, remote hostname, native renderer preservation, health/rescan, remote reload, completion, forced transport loss with fail-closed search/completion, and local restoration. ARM64 builds need separate real-host acceptance; an ARM64 build alone is not execution proof.
The RTK option checks remote output compaction and stats, control services, and—when the native executable is available—compares automatic rewriting against explicit RTK and raw passthrough. Set `PI_RTK_REQUIRE_BINARY=1` to require that native branch. Search/RTK execution has been verified on both x64 and ARM64. The official RTK 0.48.0 ARM64 binary requires glibc 2.39; older systems need a compatible build, not a system glibc upgrade.

Native tools run with the remote user's privileges, not in a sandbox. Protocol frames are bounded; cancellation is cooperative. Detached commands are not durable managed jobs, remote worktrees are unsupported, and no automatic reconnect/replay is performed.
