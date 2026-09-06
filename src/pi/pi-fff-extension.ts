import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createManagedFff } from "./plugins/fff-capture.ts";
import { managedPlugins } from "./managed-plugins.ts";
import { workspaceBinding } from "./workspace-binding.ts";
import { requestSessionContext } from "./session-context.ts";

/** Explicit entry for FFF's local UI and remotely selectable workspace runtime. */
export default function managedFffExtension(pi: ExtensionAPI): void {
  let key: object = {};
  let binding = workspaceBinding(key);
  let plugins = managedPlugins(key);
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    const restored = requestSessionContext(pi);
    if (restored !== key) {
      unregister?.();
      plugins.delete(manifest.name);
      key = restored;
      binding = workspaceBinding(key);
      plugins = managedPlugins(key);
      plugins.set(manifest.name, plugin);
      unregister = binding.register(handle);
    }
  });
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@ff-labs/pi-fff/src/index.ts");
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "../package.json"), "utf8")) as { name: string; version: string };
  if (manifest.name !== "@ff-labs/pi-fff") throw new Error("Invalid managed FFF package provenance");
  const handle = createManagedFff(pi, {
    getRoute: () => binding.phase === "local" ? "local" : binding.phase === "remote" && !binding.scope?.isClosed ? "remote" : "unavailable",
    remoteExecute: (tool, id, args, signal, onUpdate) => binding.execute(tool, id, args, signal, onUpdate),
    remoteService: (name, args, signal) => binding.service(manifest.name, name, args ?? {}, signal),
  });
  const plugin = {
    id: manifest.name,
    sourcePath: entry,
    version: manifest.version,
    tools: () => handle.getRegisteredTools(),
    config: () => handle.getConfigSnapshot(),
  };
  plugins.set(manifest.name, plugin);
  unregister = binding.register(handle);
  pi.on("session_shutdown", async () => {
    unregister?.();
    if (plugins.get(manifest.name) === plugin) plugins.delete(manifest.name);
  });
}
