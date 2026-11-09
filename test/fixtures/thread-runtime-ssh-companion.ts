import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { encodeMessage, PROTOCOL_VERSION, REMOTE_TOOL_NAMES, TOOL_RUNTIME_VERSION, type Message } from "../../src/protocol.ts";

const root = process.env.TEST_THREAD_SOCKET_ROOT;
if (!root) throw new Error("Missing isolated thread socket fixture directory");
const stat = await readFile(`/proc/${process.pid}/stat`, "utf8");
const fields = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
const identity = { pid: process.pid, start: fields[19]!, parent: Number(fields[1]) };
await appendFile(join(root, "companions.jsonl"), `${JSON.stringify(identity)}\n`);

const completionId = "thread-socket-early-completion";
let acknowledged = false;
const waiting: string[] = [];
const send = (message: Message) => process.stdout.write(encodeMessage(message));
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const request = JSON.parse(line);
  if (request.type === "initialize") {
    // This frame precedes ready on the same pipe. initialize() resolving therefore
    // fences an event already forwarded to the facade, without a scheduling sleep.
    send({ type: "event", event: "launch-completion", payload: { completionId, ...identity } });
    send({
      type: "ready", protocolVersion: PROTOCOL_VERSION, host: "omp",
      hostVersion: request.hostVersion, runtimeVersion: TOOL_RUNTIME_VERSION,
      editMode: request.editMode, cwd: request.cwd, resourceBinding: request.resourceBinding,
      capabilities: { bashServices: request.bashServices },
      tools: REMOTE_TOOL_NAMES.map(name => ({ name, description: name, parameters: { type: "object" } })),
    });
  } else if (request.type === "event-ack" && request.id === completionId) {
    acknowledged = true;
    for (const id of waiting.splice(0)) send({ type: "result", id, result: { ...identity, acknowledged } });
  } else if (request.type === "execute") {
    if (request.args.waitForAck && !acknowledged) waiting.push(request.id);
    else send({ type: "result", id: request.id, result: { ...identity, acknowledged } });
  } else if (request.type === "shutdown") {
    await writeFile(join(root, `shutdown-${identity.pid}-${identity.start}`), "shutdown received");
    process.exit(0);
  }
}
