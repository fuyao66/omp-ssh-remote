import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, REMOTE_TOOL_NAMES, TOOL_RUNTIME_VERSION, encodeMessage } from "../../src/protocol.ts";

const mode = process.argv[2];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line);
  if (request.type === "shutdown") {
    if (mode === "late-ack") await Bun.write(process.argv[3]!, "shutdown received");
    process.exit(0);
  }
  if (request.type === "initialize") {
    if (mode === "stall") {
      process.stdout.write(encodeMessage({ type: "event", event: "launch-completion", payload: { phase: "initializing" } }));
      continue;
    }
    if (mode === "fatal-initialize") {
      process.stdout.write(encodeMessage({ type: "error", error: { name: "FatalError", message: "fixture initialization failed" } }));
      // Deliberately retain stdin: the client must actually terminate this process.
      continue;
    }
    process.stdout.write(encodeMessage({
      type: "ready",
      protocolVersion: PROTOCOL_VERSION,
      host: "omp",
      hostVersion: request.hostVersion,
      runtimeVersion: TOOL_RUNTIME_VERSION,
      editMode: request.editMode,
      cwd: request.cwd,
      resourceBinding: mode === "wrong-binding" ? "wrong-remote-binding"
        : mode === "missing-binding" ? undefined : request.resourceBinding,
      capabilities: { bashServices: request.bashServices },
      tools: REMOTE_TOOL_NAMES.map(name => ({ name, description: name, parameters: { type: "object" } })),
    }));
    if (mode === "late-ack") {
      process.stdout.write(encodeMessage({ type: "event", event: "launch-completion", payload: { completionId: "late-completion" } }));
    }
  } else if (request.type === "execute" && mode === "fatal-execute") {
    process.stdout.write(encodeMessage({ type: "error", error: { name: "FatalError", message: "fixture session failed" } }));
  }
}
