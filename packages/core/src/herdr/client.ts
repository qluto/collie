import * as net from "node:net";
import { HerdrError, type HerdrEvent, type HerdrSubscription } from "./types.ts";

export interface SubscriptionHandle {
  close(): void;
}

interface WireResponse {
  id?: string;
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

const debug = process.env.AGENT_HUB_DEBUG
  ? (...args: unknown[]) => console.error("[herdr]", ...args)
  : () => {};

/**
 * Herdr socket client. Newline-delimited JSON over a unix socket.
 *
 * No multiplexing, ever: error frames from unparseable requests lose the
 * request id, so correlation on a shared connection is unsafe (verified on
 * 0.7.1). request() therefore uses one connection per call, serialized;
 * subscribe() holds a dedicated long-lived connection.
 */
export class HerdrClient {
  private chain: Promise<unknown> = Promise.resolve();
  private seq = 0;

  constructor(private socketPath: string) {}

  request<T = Record<string, unknown>>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const result = this.chain.then(
      () => this.requestRaw<T>(method, params, opts?.timeoutMs ?? 10_000),
    );
    // keep the chain alive even when a request fails
    this.chain = result.catch(() => {});
    return result;
  }

  private requestRaw<T>(method: string, params: Record<string, unknown> | undefined, timeoutMs: number): Promise<T> {
    const id = `ah_${process.pid}_${++this.seq}`;
    const frame = JSON.stringify({ id, method, params: params ?? {} }) + "\n";
    debug("->", frame.trim());
    return new Promise<T>((resolve, reject) => {
      const sock = net.createConnection(this.socketPath);
      let buffer = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        fn();
      };
      sock.setTimeout(timeoutMs, () =>
        finish(() => reject(new HerdrError("timeout", `${method} timed out after ${timeoutMs}ms`))),
      );
      sock.once("error", (err) =>
        finish(() => reject(new HerdrError("socket", `${method}: ${err.message}`))),
      );
      sock.once("connect", () => sock.write(frame));
      sock.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl === -1) return;
        const line = buffer.slice(0, nl);
        debug("<-", line);
        finish(() => {
          let parsed: WireResponse;
          try {
            parsed = JSON.parse(line) as WireResponse;
          } catch {
            reject(new HerdrError("protocol", `unparseable response to ${method}`));
            return;
          }
          if (parsed.error) {
            reject(new HerdrError(parsed.error.code, `${method}: ${parsed.error.message}`));
          } else {
            resolve(parsed.result as T);
          }
        });
      });
    });
  }

  /**
   * Open a dedicated connection, send events.subscribe, then push parsed
   * event frames to onEvent. The first response line acks the subscription
   * (or carries an error). onClose fires exactly once when the connection
   * dies; the OWNER decides whether to resubscribe.
   */
  subscribe(
    subscriptions: HerdrSubscription[],
    onEvent: (e: HerdrEvent) => void,
    onClose: (err?: Error) => void,
  ): SubscriptionHandle {
    const id = `ah_sub_${process.pid}_${++this.seq}`;
    const frame = JSON.stringify({ id, method: "events.subscribe", params: { subscriptions } }) + "\n";
    debug("-> sub", frame.trim());
    const sock = net.createConnection(this.socketPath);
    let buffer = "";
    let acked = false;
    let closed = false;
    const emitClose = (err?: Error) => {
      if (closed) return;
      closed = true;
      sock.destroy();
      onClose(err);
    };
    sock.once("connect", () => sock.write(frame));
    sock.once("error", (err) => emitClose(new HerdrError("socket", err.message)));
    sock.once("close", () => emitClose());
    sock.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim().length === 0) continue;
        debug("<- sub", line);
        let parsed: WireResponse & Partial<HerdrEvent>;
        try {
          parsed = JSON.parse(line) as WireResponse & Partial<HerdrEvent>;
        } catch {
          continue; // tolerate garbage on the stream
        }
        if (!acked) {
          acked = true;
          if (parsed.error) {
            emitClose(new HerdrError(parsed.error.code, parsed.error.message));
            return;
          }
          continue; // subscription_started ack
        }
        if (typeof parsed.event === "string") {
          onEvent(parsed as HerdrEvent);
        }
      }
    });
    return {
      close: () => {
        closed = true; // suppress onClose for caller-initiated close
        sock.destroy();
      },
    };
  }
}
