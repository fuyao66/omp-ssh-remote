import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

export interface AftBridgeClient {
  isAvailable(): boolean;
  send(command: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export function createAftBridgeClient(cwd: string, aftBinPath?: string): AftBridgeClient {
  let resolvedBinary: string | undefined;

  // Search for deployed aft binary
  const candidates = [
    aftBinPath,
    join(dirname(process.argv[1] || ""), "aft"),
    join(process.cwd(), "aft"),
    "/root/.cache/omp-ssh-remote/pi/current/aft",
    "/root/.cache/omp-ssh-remote/aft/x64/current/aft",
    "/usr/local/bin/aft",
    "aft",
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (c.includes("/") && existsSync(c)) {
        resolvedBinary = c;
        break;
      }
    } catch {}
  }

  // Also check ~/.cache/omp-ssh-remote/aft/x64/*
  if (!resolvedBinary) {
    try {
      const base = join(process.env.HOME || "/root", ".cache/omp-ssh-remote/aft");
      for (const arch of ["x64", "arm64"]) {
        const archDir = join(base, arch);
        if (existsSync(archDir)) {
          const hashes = readdirSync(archDir);
          for (const h of hashes) {
            const bin = join(archDir, h, "aft");
            if (existsSync(bin)) {
              resolvedBinary = bin;
              break;
            }
          }
        }
      }
    } catch {}
  }

  if (!resolvedBinary) {
    resolvedBinary = "aft";
  }

  let child: ChildProcess | undefined;
  const pendingRequests = new Map<string, { resolve: (val: unknown) => void; reject: (err: Error) => void }>();
  let reqSeq = 0;
  let closed = false;
  let configured = false;

  function ensureChild(): ChildProcess {
    if (closed) throw new Error("AFT bridge client is closed");
    if (child && !child.killed && child.exitCode === null) {
      return child;
    }

    const proc = spawn(resolvedBinary!, [], {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
      env: {
        ...process.env,
        AFT_PROJECT_ROOT: cwd,
      },
    });

    const rl = createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line) as { id?: string; success?: boolean; code?: string; message?: string; [k: string]: unknown };
        if (msg.id && pendingRequests.has(msg.id)) {
          const { resolve, reject } = pendingRequests.get(msg.id)!;
          pendingRequests.delete(msg.id);
          if (msg.success === false) {
            reject(new Error(msg.message || msg.code || "AFT error"));
          } else {
            resolve(msg);
          }
        }
      } catch (err) {
        console.error("[aft-bridge-client] parse error:", err);
      }
    });

    proc.on("exit", (code) => {
      for (const [id, req] of pendingRequests) {
        req.reject(new Error(`AFT process exited with code ${code}`));
      }
      pendingRequests.clear();
      child = undefined;
      configured = false;
    });

    child = proc;
    return proc;
  }

  async function rawSend(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const proc = ensureChild();
    const id = `aft-req-${Date.now()}-${++reqSeq}`;
    const payload = JSON.stringify({
      id,
      command,
      ...params,
    });

    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    pendingRequests.set(id, { resolve, reject });
    proc.stdin!.write(payload + "\n");
    return promise;
  }

  async function ensureConfigured(): Promise<void> {
    if (configured) return;
    await rawSend("configure", {
      project_root: cwd,
      harness: "pi",
    });
    configured = true;
  }

  // Map public tool names to AFT internal wire command names
  const COMMAND_MAP: Record<string, string> = {
    ast_grep_search: "ast_search",
    ast_grep_replace: "ast_replace",
    aft_outline: "outline",
    aft_zoom: "zoom",
    aft_inspect: "inspect",
    aft_callgraph: "navigate",
    aft_semantic: "semantic",
    aft_conflicts: "conflicts",
    aft_safety: "safety",
    aft_undo: "undo",
  };

  return {
    isAvailable: () => {
      try {
        return resolvedBinary ? existsSync(resolvedBinary) : false;
      } catch {
        return false;
      }
    },

    send: async (toolName: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      await ensureConfigured();
      const wireCommand = COMMAND_MAP[toolName] ?? toolName;
      return rawSend(wireCommand, params);
    },

    close: async () => {
      closed = true;
      if (child) {
        try {
          child.stdin?.end();
          child.kill("SIGTERM");
        } catch {}
        child = undefined;
      }
      for (const [id, req] of pendingRequests) {
        req.reject(new Error("AFT bridge client closed"));
      }
      pendingRequests.clear();
    },
  };
}
