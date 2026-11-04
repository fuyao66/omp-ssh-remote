import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
// @ts-expect-error Generated release bundle has no declaration file.
import extension from "../packages/omp/dist/extension.js";

type SmokeCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

export async function bootstrapSmokeHost(pi: ExtensionAPI): Promise<Map<string, SmokeCommand>> {
  const commands = new Map<string, SmokeCommand>();
  const api = new Proxy(pi, {
    get(target, key) {
      if (key === "registerCommand") {
        return (name: string, command: SmokeCommand) => {
          commands.set(name, command);
          return target.registerCommand(name, command);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await extension(api);
  return commands;
}
