import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";

const root = () => join(homedir(), ".cache/omp-ssh-remote/artifacts");
const references = /remote-artifact:\/\/([a-f0-9-]{36})\/(\d+)/g;

export async function resolveRemoteArtifacts(value: unknown): Promise<unknown> {
  if (typeof value === "string") {
    let result = value;
    for (const match of value.matchAll(references)) {
      const dir = join(root(), match[1]!);
      const name = (await readdir(dir)).find((name) => name.startsWith(`${match[2]}.`));
      if (!name) throw new Error(`Remote artifact not found: ${match[0]}`);
      result = result.replaceAll(match[0], join(dir, name));
    }
    return result;
  }
  if (Array.isArray(value)) return Promise.all(value.map(resolveRemoteArtifacts));
  if (value && typeof value === "object") {
    return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveRemoteArtifacts(item)])));
  }
  return value;
}

export async function createRemoteArtifacts() {
  const namespace = crypto.randomUUID();
  const dir = join(root(), namespace);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const manager = new ArtifactManager(dir);
  const publish = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(/artifact:\/\/(\d+)/g, `remote-artifact://${namespace}/$1`);
    if (Array.isArray(value)) return value.map(publish);
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const result = Object.fromEntries(Object.entries(record).filter(([key]) => key !== "artifactId").map(([key, item]) => [key, publish(item)]));
      const details = record.details as { meta?: { truncation?: { artifactId?: string } } } | undefined;
      const id = details?.meta?.truncation?.artifactId;
      if (typeof id === "string" && Array.isArray(result.content)) {
        result.content = [...result.content, { type: "text", text: `Full output: remote-artifact://${namespace}/${id}` }];
      }
      return result;
    }
    return value;
  };
  return { manager, publish };
}
