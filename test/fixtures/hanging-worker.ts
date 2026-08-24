import { createInterface } from "node:readline";
import { PROTOCOL_VERSION, REMOTE_TOOL_NAMES, TOOL_RUNTIME_VERSION, encodeMessage } from "../../src/protocol.ts";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  const request = JSON.parse(line) as { type?: string; cwd?: string; hostVersion?: string; ompVersion?: string };
  if (request.type !== "initialize") continue;
  const hostVersion = request.hostVersion ?? request.ompVersion ?? "test";
  process.stdout.write(
    encodeMessage({
      type: "ready",
      protocolVersion: PROTOCOL_VERSION,
      host: "omp",
      ompVersion: hostVersion,
      hostVersion,
      runtimeVersion: TOOL_RUNTIME_VERSION,
      cwd: request.cwd ?? process.cwd(),
      tools: REMOTE_TOOL_NAMES.map(name => ({ name, description: name, parameters: { type: "object" } })),
    }),
  );
}
