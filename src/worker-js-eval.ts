import { startJsEvalProcess } from "@oh-my-pi/pi-coding-agent/eval/js/process-entry";
import type { WorkerInbound, WorkerOutbound } from "@oh-my-pi/pi-coding-agent/eval/js/worker-protocol";
import { interceptUnhandledRejections } from "@oh-my-pi/pi-utils/postmortem";

export async function runJsEvalProcessHost(): Promise<void> {
  const { promise: disconnected, resolve } = Promise.withResolvers<void>();
  type IpcSend = (this: NodeJS.Process, message: unknown, callback?: (error: Error | null) => void) => boolean;
  const ipcProcess = process as NodeJS.Process & { send?: IpcSend };
  const send = (message: WorkerOutbound): void => {
    const sender = ipcProcess.send;
    if (!sender) {
      resolve();
      return;
    }
    try {
      sender.call(process, message);
    } catch (error) {
      if (process.connected) throw error;
      resolve();
    }
  };
  startJsEvalProcess(
    {
      send,
      onMessage(handler) {
        const listener = (message: unknown): void => handler(message as WorkerInbound);
        process.on("message", listener);
        return () => process.off("message", listener);
      },
    },
    interceptUnhandledRejections,
  );
  const keepalive = setInterval(() => {}, 2 ** 30);
  process.on("disconnect", resolve);
  try {
    await disconnected;
  } finally {
    clearInterval(keepalive);
  }
  process.kill(process.pid, "SIGKILL");
}
