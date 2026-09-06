import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createManagedRtk } from "./plugins/rtk-capture.ts";
import { managedPlugins } from "./managed-plugins.ts";
import { workspaceBinding } from "./workspace-binding.ts";
import { requestSessionContext } from "./session-context.ts";

/** Explicit opt-in entry for RTK's local controls and remotely selectable hook runtime. */
export default async function managedRtkExtension(pi: ExtensionAPI): Promise<void> {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("pi-rtk-optimizer");
  const manifest = JSON.parse(readFileSync(join(dirname(entry), "package.json"), "utf8")) as { name: string; version: string };
  if (manifest.name !== "pi-rtk-optimizer" || manifest.version !== "0.9.0") {
    throw new Error("Invalid managed RTK package provenance");
  }
  const hasRawRtk = () => pi.getCommands().some((command) =>
    (command.name === "rtk" || command.name.startsWith("rtk:")) &&
    command.source === "extension" &&
    !command.sourceInfo.path.replace(/\\/g, "/").endsWith("/src/pi/pi-rtk-extension.ts") &&
    !command.sourceInfo.path.replace(/\\/g, "/").endsWith("/dist/pi-rtk-extension.js"),
  );
  let key: object = {};
  let binding = workspaceBinding(key);
  let plugins = managedPlugins(key);
  let unregister: (() => void) | undefined;
  pi.on("session_start", async () => {
    if (hasRawRtk()) {
      throw new Error("Raw pi-rtk-optimizer is already loaded; remote RTK cannot safely coexist with local RTK hooks");
    }
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
  const handle = await createManagedRtk(pi, {
    getRoute: () => binding.phase === "local" ? "local" : binding.phase === "remote" && !binding.scope?.isClosed ? "remote" : "unavailable",
    remoteService: (name, args, signal) => binding.service(manifest.name, name, args ?? {}, signal),
  });
  const plugin = {
    id: manifest.name,
    sourcePath: entry,
    version: manifest.version,
    tools: () => [],
    config: () => handle.getConfigSnapshot(),
  };
  plugins.set(manifest.name, plugin);
  unregister = binding.register(handle);
  pi.on("session_shutdown", async () => {
    unregister?.();
    await handle.shutdown();
    if (plugins.get(manifest.name) === plugin) plugins.delete(manifest.name);
  });
}
