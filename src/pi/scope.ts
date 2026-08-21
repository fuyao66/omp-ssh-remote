import { RemoteRuntimeClient } from "../client.ts";
import type { RemoteConnectRequest } from "../connect-options.ts";
import type { ReadyMessage } from "../protocol.ts";
import { buildSshWorkerCommand } from "../ssh.ts";
import type { PiRuntimeAssembly } from "./assembly.ts";

export interface OpenPiRemoteScopeOptions {
  assembly: PiRuntimeAssembly;
  connectOptions: RemoteConnectRequest;
  workerPath: string;
  cwd: string;
  initializeTimeoutMs?: number;
}

export class PiRemoteWorkspaceScope {
  readonly assembly: PiRuntimeAssembly;
  readonly connectOptions: RemoteConnectRequest;
  readonly workerPath: string;
  readonly cwd: string;
  readonly client: RemoteRuntimeClient;
  readonly ready: ReadyMessage;

  private constructor(
    options: OpenPiRemoteScopeOptions,
    client: RemoteRuntimeClient,
    ready: ReadyMessage,
  ) {
    this.assembly = options.assembly;
    this.connectOptions = options.connectOptions;
    this.workerPath = options.workerPath;
    this.cwd = options.cwd;
    this.client = client;
    this.ready = ready;
  }

  static async open(
    options: OpenPiRemoteScopeOptions,
  ): Promise<PiRemoteWorkspaceScope> {
    const client = new RemoteRuntimeClient({
      command: buildSshWorkerCommand({
        target: options.connectOptions.target,
        port: options.connectOptions.port,
        identityFile: options.connectOptions.identityFile,
        knownHostsFile: options.connectOptions.knownHostsFile,
        workerPath: options.workerPath,
      }),
    });
    try {
      const ready = await client.initialize(
        options.cwd,
        options.assembly.handshake,
        options.initializeTimeoutMs ?? 30_000,
      );
      return new PiRemoteWorkspaceScope(options, client, ready);
    } catch (error) {
      if (!client.isClosed) client.kill();
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.client.isClosed;
  }

  execute(
    tool: string,
    toolCallId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: unknown) => void,
  ): Promise<unknown> {
    if (!this.assembly.knownWorkspaceTools.has(tool)) {
      throw new Error(
        `Tool ${tool} is not admitted by Pi assembly ${this.assembly.id}`,
      );
    }
    return this.client.execute(tool, toolCallId, args, signal, onUpdate);
  }

  async close(force = false): Promise<void> {
    if (this.client.isClosed) return;
    try {
      await this.client.close();
    } catch (error) {
      if (!force) throw error;
      this.client.kill();
    }
  }
}
