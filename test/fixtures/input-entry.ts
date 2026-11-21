import { spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import { cfgBareSlashCommands } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { isLocalAgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import * as deploy from "../../src/deploy.ts";
import * as host from "../../src/omp/host-identity.ts";
import { SUPPORTED_SDK_VERSION } from "../../src/omp/sdk-contract.ts";
import * as ssh from "../../src/ssh.ts";
import remote from "../../src/extension.ts";

export interface TuiRequest {
  bare: boolean;
  nonempty?: boolean;
  /** null presses Enter on the existing draft, including a restored confirmation. */
  enter: (string | null)[];
}

const tracePath = process.env.INPUT_ENTRY_TRACE;
function trace(kind: string, value: unknown) {
  appendFileSync(tracePath!, JSON.stringify({ kind, value }) + "\n");
}

if (tracePath) {
  // Loaded as a Bun preload before the CLI initializes any clients. A fake credential
  // lets native prompt preflight run, but neither main nor auxiliary model requests may leave the process.
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/^https:\/\/api\.openai\.com\/v1\/(?:responses|chat\/completions)(?:[/?]|$)/.test(url)) {
      trace("unexpected-provider-fetch", url);
    }
    throw new Error("Network access is forbidden in the input-entry fixture");
  }, { preconnect: () => {} });

  spyOn(host, "resolveOmpHostVersion").mockResolvedValue(SUPPORTED_SDK_VERSION);
  spyOn(ssh, "buildSshWorkerCommand").mockReturnValue([
    process.execPath, fileURLToPath(new URL("../../src/worker.ts", import.meta.url)),
  ]);
  spyOn(deploy, "prepareRemoteWorker").mockImplementation(async options => {
    const cacheAudit = { available: false as const, observedAt: "fixture", warning: "fixture" };
    return {
      workerPath: "/fixture/worker", home: "/remote", signal: options.signal!, cacheAudit,
      async dispose() {}, async commitUsage() { return cacheAudit; },
    };
  });
  spyOn(Agent.prototype, "prompt").mockImplementation(async messages => {
    // This boundary receives the real prepared messages, including any injected local files.
    trace("prepared-prompt", messages);
    throw new Error("Fixture stopped before starting the model turn");
  });
}

export default async function inputEntryFixture(pi: ExtensionAPI) {
  const sessionFor = (id: string) => {
    const session = AgentRegistry.global().get(id)?.session;
    if (!session || !isLocalAgentSession(session)) throw new Error("No native owning session");
    return session;
  };
  pi.on("input", event => { trace("input", { text: event.text, source: event.source }); });
  pi.registerCommand("fixture-bare", {
    description: "Change the native setting for input entry tests",
    async handler(args, ctx) {
      const session = sessionFor(ctx.agent.id);
      cfgBareSlashCommands.override(session.settings, args === "on");
      trace("bare-setting", cfgBareSlashCommands.get(session.settings));
    },
  });
  pi.registerCommand("fixture-tui", {
    description: "Drive the native TUI editor submit callback without a terminal",
    async handler(args, ctx) {
      const scenario: TuiRequest = JSON.parse(args);
      const native = sessionFor(ctx.agent.id);
      cfgBareSlashCommands.override(native.settings, scenario.bare);
      const editor = {
        text: "", pendingImages: [], pendingImageLinks: [],
        onSubmit: undefined as ((text: string) => unknown) | undefined,
        getText() { return this.text; },
        setText(text: string) { this.text = text; },
        addToHistory() {},
      };
      const controller = new InputController({
        editor, settings: native.settings, sessionManager: native.sessionManager,
        session: {
          extensionRunner: native.extensionRunner, isStreaming: false,
          messages: scenario.nonempty ? [{ role: "user", content: "Prior message" }] : [],
          customCommands: native.customCommands, promptTemplates: native.promptTemplates,
        },
        locallySubmittedUserSignatures: new Map(), skillCommands: new Map(), fileSlashCommands: new Map(),
        showGitUi: () => trace("tui-git-ui", true),
        handleLoopCommand: (text: string) => trace("tui-loop", text),
        showStatus: (text: string) => trace("tui-status", text),
        flushPendingBashComponents() {},
        startPendingSubmission: ({ text }: { text: string }) => ({ text }),
        onInputCallback: ({ text }: { text: string }) => trace("tui-prompt", text),
      } as unknown as ConstructorParameters<typeof InputController>[0]);
      controller.setupEditorSubmitHandler();
      for (const next of scenario.enter) {
        const text = next ?? editor.getText();
        // The native editor clears its draft before invoking onSubmit.
        editor.setText("");
        await editor.onSubmit!(text);
        trace("tui-enter-complete", editor.getText());
      }
    },
  });
  await remote(pi);
}
