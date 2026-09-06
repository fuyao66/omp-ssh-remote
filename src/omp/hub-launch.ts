import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";
import type { RemoteNativeTool } from "../runtime.ts";
import { isHubLaunchOperation } from "./hub-ops.ts";

export { isHubLaunchOperation };
/**
 * Remote companion `hub`: the native HubTool bound to the remote ToolSession,
 * restricted to the launch half. Messaging and job ops never reach the remote
 * host (they are local control-plane concerns), so an attempt is a routing
 * bug and fails closed rather than answering from a peer-less remote session.
 */
export function createRemoteHubLaunchTool(session: ToolSession): RemoteNativeTool {
  const native = new HubTool(session);
  return {
    name: native.name,
    description: native.description,
    parameters: native.parameters,
    async execute(toolCallId, params, signal, onUpdate, context) {
      if (!isHubLaunchOperation(params)) {
        throw new Error(
          `Remote hub only supervises processes; op=${String(params.op)} is a local control-plane operation`,
        );
      }
      return native.execute(
        toolCallId,
        params as Parameters<HubTool["execute"]>[1],
        signal,
        onUpdate as Parameters<HubTool["execute"]>[3],
        context as Parameters<HubTool["execute"]>[4],
      );
    },
  };
}
