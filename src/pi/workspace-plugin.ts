/** Worker-side state owned by a managed workspace plugin. */
export interface WorkspacePluginHandle {
  getConfigSnapshot?(): Record<string, unknown>;
  service(name: string, args?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  suspend?(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Hooks faithfully driven by the model-free workspace execution path. */
export const WORKSPACE_HOOKS = [
  "session_start",
  "tool_call",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_result",
  "session_shutdown",
] as const;

export type WorkspaceHook = (typeof WORKSPACE_HOOKS)[number];

export type WorkspaceExecutableTool = {
  prepareArguments?(input: unknown): unknown;
  execute(toolCallId: string, args: unknown, signal?: AbortSignal, onUpdate?: (update: unknown) => void, context?: unknown): Promise<WorkspaceToolResult>;
};

export type WorkspaceToolResult = {
  content?: unknown[];
  details?: unknown;
  isError?: boolean;
  usage?: unknown;
  [key: string]: unknown;
};

export type WorkspaceToolRunner = {
  emit(event: never): Promise<unknown>;
  emitToolCall(event: never): Promise<{ block?: boolean; reason?: string; terminate?: boolean } | undefined>;
  emitToolResult(event: never): Promise<Partial<WorkspaceToolResult> | undefined>;
  createContext(): unknown;
};

function errorResult(message: string): WorkspaceToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Runs Pi's workspace-tool execution path without creating a model turn.
 * Model, provider, UI, and control hooks have no real event here and are not
 * forwarded. Tool-result hook failures become observable failed tool results.
 */
export async function executeWorkspaceTool(input: {
  runner?: WorkspaceToolRunner;
  tool: WorkspaceExecutableTool;
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  onUpdate?: (update: unknown) => void;
}): Promise<WorkspaceToolResult> {
  const { runner, tool, toolName, toolCallId, signal, onUpdate } = input;
  const startArgs = input.args;
  await runner?.emit({ type: "tool_execution_start", toolCallId, toolName, args: startArgs } as never);

  let args: unknown = startArgs;
  let result: WorkspaceToolResult;
  let isError = false;
  let ranTool = false;
  let updates = Promise.resolve();
  let acceptingUpdates = true;
  try {
    if (signal?.aborted) throw new Error("Operation aborted");
    args = tool.prepareArguments ? tool.prepareArguments(startArgs) : startArgs;
    const call = await runner?.emitToolCall({ type: "tool_call", toolCallId, toolName, input: args } as never);
    if (signal?.aborted) throw new Error("Operation aborted");
    if (call?.block) {
      result = errorResult(call.reason || "Tool execution was blocked");
      if (call.terminate) result.terminate = true;
      isError = true;
    } else {
      ranTool = true;
      result = await tool.execute(toolCallId, args, signal, (partialResult) => {
        if (!acceptingUpdates) return;
        updates = updates.then(async () => {
          if (!runner) {
            onUpdate?.(partialResult);
            return;
          }
          const event = { type: "tool_execution_update", toolCallId, toolName, args, partialResult };
          await runner.emit(event as never);
          onUpdate?.(event.partialResult);
        });
      }, runner?.createContext());
      acceptingUpdates = false;
      await updates;
      isError = result.isError === true;
    }
  } catch (error) {
    acceptingUpdates = false;
    await updates.catch(() => {});
    result = errorResult(error instanceof Error ? error.message : String(error));
    isError = true;
  }

  if (ranTool) {
    try {
      const hookResult = await runner?.emitToolResult({
        type: "tool_result",
        toolCallId,
        toolName,
        input: args,
        content: result.content ?? [],
        details: result.details,
        isError,
        usage: result.usage,
      } as never);
      if (hookResult) result = {
        ...result,
        content: hookResult.content ?? result.content,
        details: hookResult.details ?? result.details,
        usage: hookResult.usage ?? result.usage,
        isError: hookResult.isError ?? isError,
      };
      isError = result.isError === true;
    } catch (error) {
      result = errorResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  result.isError = isError;
  await runner?.emit({ type: "tool_execution_end", toolCallId, toolName, result, isError } as never);
  return result;
}
