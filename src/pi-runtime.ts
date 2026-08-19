import {
  createReadTool,
  createWriteTool,
  createEditTool,
  createBashTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@earendil-works/pi-coding-agent";
import {
  PROTOCOL_VERSION,
  PI_VERSION,
  PI_TOOL_RUNTIME_VERSION,
  AFT_EXTENDED_TOOLS,
  type ExecuteRequest,
  type ReadyMessage,
  type ToolManifest,
} from "./protocol.ts";
import { createAftBridgeClient, type AftBridgeClient } from "./aft-bridge-client.ts";

export interface PiNativeWorkerRuntime {
  manifest: ReadyMessage;
  execute(request: ExecuteRequest): Promise<unknown>;
  close(): Promise<void>;
}

export { AFT_EXTENDED_TOOLS };
export function createPiNativeWorkerRuntime(
  cwd: string,
  _settings: Record<string, unknown> = {},
): PiNativeWorkerRuntime {
  const aftBridge: AftBridgeClient = createAftBridgeClient(cwd);

  const nativeTools: Record<string, { description: string; parameters?: unknown; execute: (...args: any[]) => Promise<unknown> }> = {
    read: createReadTool(cwd),
    write: createWriteTool(cwd),
    edit: createEditTool(cwd),
    bash: createBashTool(cwd),
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
    ls: createLsTool(cwd),
  };

  const toolNames = [...Object.keys(nativeTools), ...AFT_EXTENDED_TOOLS];

  const manifestTools: ToolManifest[] = toolNames.map((name) => {
    const native = nativeTools[name];
    if (native) {
      return {
        name,
        description: native.description,
        parameters: native.parameters as Record<string, unknown> | undefined,
      };
    }
    return {
      name,
      description: `[AFT Remote Native] ${name} executed on remote AFT engine`,
      parameters: {} as Record<string, unknown>,
    };
  });

  const manifest: ReadyMessage = {
    type: "ready",
    protocolVersion: PROTOCOL_VERSION,
    toolRuntimeVersion: PI_TOOL_RUNTIME_VERSION,
    host: "pi",
    hostVersion: PI_VERSION,
    tools: manifestTools,
    capabilities: {
      artifacts: false,
      lsp: false,
      ast: true,
      eval: false,
      debug: false,
      sessionSpawns: "disabled",
      asyncBash: "disabled",
      remoteWorktrees: "disabled",
    },
  };

  async function execute(request: ExecuteRequest): Promise<unknown> {
    const nativeTool = nativeTools[request.tool];
    if (nativeTool) {
      const abortController = new AbortController();
      const result = await nativeTool.execute(
        request.id,
        request.args,
        abortController.signal,
        undefined,
      );
      return result;
    }

    // AFT Extended Tools -> Dispatch to remote AFT bridge engine
    if (AFT_EXTENDED_TOOLS.includes(request.tool)) {
      try {
        const aftCommand = request.tool;
        const res = await aftBridge.send(aftCommand, request.args);
        return {
          content: [
            {
              type: "text",
              text: typeof res === "string" ? res : JSON.stringify(res, null, 2),
            },
          ],
          details: res,
        };
      } catch (error) {
        throw new Error(`Remote AFT engine error on ${request.tool}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new Error(`Unknown Pi tool: ${request.tool}`);
  }

  async function close(): Promise<void> {
    await aftBridge.close();
  }

  return {
    manifest,
    execute,
    close,
  };
}
