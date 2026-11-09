import type { Socket } from "node:net";
import { serialize, deserialize } from "node:v8";
import { RpcLink, type RpcApi, type RpcEndpoint, type RpcFrame } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import { MAX_FRAME_BYTES } from "./protocol.ts";

/** The companion's 16 MiB frame plus native RPC tags and binary encoding overhead. */
export const THREAD_RPC_FRAME_BYTES = 2 * MAX_FRAME_BYTES;
export const THREAD_RPC_QUEUED_BYTES = 2 * THREAD_RPC_FRAME_BYTES;
export const THREAD_RPC_CALLBACK_CALLS = 64;
export const THREAD_RPC_CALLBACK_BYTES = THREAD_RPC_FRAME_BYTES;

export interface ThreadRpcConnection<Local extends RpcApi, Remote extends RpcApi> {
  readonly link: RpcLink<Local, Remote>;
  close(reason?: string): void;
}

/** Native RPC owns correlation, callbacks, errors and signals; this adapter owns only bytes. */
export function socketRpc<Local extends RpcApi, Remote extends RpcApi>(
  socket: Socket,
  name: string,
  onLost: (error: Error) => void,
): ThreadRpcConnection<Local, Remote> {
  let listener: ((frame: RpcFrame) => void) | undefined;
  let connection: ThreadRpcConnection<Local, Remote> | undefined;
  let closed = false;
  let queued = 0;
  const header = Buffer.alloc(4);
  let headerBytes = 0;
  let body: Buffer | undefined;
  let bodyBytes = 0;
  const fail = (value: unknown) => {
    if (closed) return;
    closed = true;
    const error = value instanceof Error ? value : new Error(String(value));
    // Retire ownership before native close aborts mirrored signals and callbacks.
    try { onLost(error); }
    finally {
      connection?.link.close(error.message);
      socket.destroy();
    }
  };
  const endpoint: RpcEndpoint = {
    send(frame) {
      if (closed) return;
      try {
        const payload = serialize(frame);
        if (payload.length > THREAD_RPC_FRAME_BYTES) throw new Error("Remote thread RPC frame exceeded its byte limit");
        const size = payload.length + 4;
        if (queued + size > THREAD_RPC_QUEUED_BYTES) throw new Error("Remote thread RPC write queue exceeded its byte limit");
        const frameHeader = Buffer.allocUnsafe(4);
        frameHeader.writeUInt32BE(payload.length);
        queued += size;
        socket.write(Buffer.concat([frameHeader, payload], size), error => {
          queued -= size;
          if (error) fail(error);
        });
      } catch (error) { fail(error); }
    },
    listen(handler) {
      listener = handler;
      return () => { listener = undefined; };
    },
  };
  connection = {
    link: new RpcLink<Local, Remote>(endpoint, { name }),
    close(reason = "Remote thread RPC closed") { fail(new Error(reason)); },
  };
  socket.on("data", (chunk: Buffer) => {
    try {
      let offset = 0;
      while (!closed && offset < chunk.length) {
        if (!body) {
          const count = Math.min(4 - headerBytes, chunk.length - offset);
          chunk.copy(header, headerBytes, offset, offset + count);
          headerBytes += count;
          offset += count;
          if (headerBytes !== 4) continue;
          const length = header.readUInt32BE();
          if (length === 0 || length > THREAD_RPC_FRAME_BYTES) throw new Error("Invalid remote thread RPC frame length");
          body = Buffer.allocUnsafe(length);
          bodyBytes = 0;
          headerBytes = 0;
        }
        const count = Math.min(body.length - bodyBytes, chunk.length - offset);
        chunk.copy(body, bodyBytes, offset, offset + count);
        bodyBytes += count;
        offset += count;
        if (bodyBytes !== body.length) continue;
        const frame = deserialize(body) as RpcFrame;
        body = undefined;
        if (!frame || typeof frame !== "object" || typeof frame.t !== "string") throw new Error("Invalid remote thread RPC frame");
        listener?.(frame);
      }
    } catch (error) { fail(error); }
  });
  socket.once("end", () => fail(new Error("Remote thread RPC peer ended its channel")));
  socket.once("close", () => fail(new Error("Remote thread RPC peer closed its channel")));
  socket.on("error", fail);
  return connection;
}

/** Void native progress sources cannot await RPC: cap their live promises as well as bytes. */
export class ThreadCallbackBudget {
  #calls = 0;
  #bytes = 0;
  constructor(private readonly fail: (error: Error) => void, private readonly closing: () => boolean) {}

  call<T>(args: unknown[], deliver: () => Promise<T>, allowClosing = false): Promise<T | undefined> {
    if (this.closing() && !allowClosing) return Promise.resolve(undefined);
    let bytes: number;
    try { bytes = serialize(args).length; }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.fail(failure); return Promise.reject(failure);
    }
    if (this.#calls >= THREAD_RPC_CALLBACK_CALLS || this.#bytes + bytes > THREAD_RPC_CALLBACK_BYTES) {
      const error = new Error("Remote thread callback backlog exceeded its limit");
      this.fail(error); return Promise.reject(error);
    }
    this.#calls++;
    this.#bytes += bytes;
    let promise: Promise<T>;
    try { promise = deliver(); }
    catch (error) { promise = Promise.reject(error); }
    return promise.then(value => {
      this.#calls--; this.#bytes -= bytes;
      return value;
    }, error => {
      this.#calls--; this.#bytes -= bytes;
      throw error;
    });
  }

  send(args: unknown[], deliver: () => Promise<unknown>, allowClosing = false): void {
    void this.call(args, deliver, allowClosing).catch(error => {
      if (!this.closing()) this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }
}
