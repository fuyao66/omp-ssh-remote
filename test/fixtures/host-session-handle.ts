import type { AgentSessionHandle } from "@oh-my-pi/pi-coding-agent/session/agent-session-handle";
import { currentThreadId } from "@oh-my-pi/pi-coding-agent/thread/identity";

/** A registry fixture with real thread identity; unexpected full-session access fails explicitly. */
export function hostSessionHandle(
  getSessionFile: () => string,
  instanceKey = `${currentThreadId()}:${crypto.randomUUID()}`,
): AgentSessionHandle {
  const unsupported = (): never => { throw new Error("Registry fixture does not implement full session execution"); };
  return {
    instanceKey,
    agent: { isPaused: false, state: { messages: [], streamMessage: null, pendingToolCalls: new Set() } },
    sessionManager: {
      getCwd: () => "/",
      getSessionId: () => instanceKey,
      getSessionFile,
      getArtifactsDir: () => null,
      getUsageStatistics: unsupported,
    },
    isStreaming: false,
    runStartedAt: undefined,
    ircWakesPending: false,
    messages: [],
    get sessionFile() { return getSessionFile(); },
    model: undefined,
    thinkingLevel: undefined,
    servingModel: undefined,
    effectiveExtensionRoots: { explicit: [], mode: "explicit-only", configured: [], configuredLevel: "user" },
    hindsightActive: false,
    subscribe: () => () => {},
    subscribeRunState: () => () => {},
    getSessionStats: unsupported,
    getAdvisorStatusOverview: () => ({ configured: false, advisors: [] }),
    getSessionAgents: () => [],
    hasQueuedIrcFrom: () => false,
    hasIrcInterrupts: () => false,
    emitIrcRelayObservation: unsupported,
    deliverIrcMessage: async () => unsupported(),
    waitForIrcReplies: async () => {},
    prompt: async () => unsupported(),
    steer: async () => unsupported(),
    abort: async () => {},
    setWorkPoolYieldItems: async () => unsupported(),
    dispose: async () => {},
  };
}
