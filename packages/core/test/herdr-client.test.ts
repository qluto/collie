import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { HerdrClient, HerdrError } from "../src/index.ts";

type Fake = { socketPath: string; stop: () => void; connections: Bun.SocketHandler<undefined> };

function fakeServer(handler: (line: string, write: (s: string) => void) => void): { socketPath: string; stop: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "herdr-fake-"));
  const socketPath = path.join(dir, "herdr.sock");
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().length > 0) handler(line, (s) => socket.write(s));
        }
      },
    },
  });
  return { socketPath, stop: () => server.stop(true) };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

describe("HerdrClient.request", () => {
  test("round-trips a request and parses result", async () => {
    const srv = fakeServer((line, write) => {
      const req = JSON.parse(line);
      expect(req.method).toBe("ping");
      write(JSON.stringify({ id: req.id, result: { type: "pong", version: "0.7.1" } }) + "\n");
    });
    cleanup.push(srv.stop);
    const client = new HerdrClient(srv.socketPath);
    const res = await client.request<{ type: string; version: string }>("ping");
    expect(res.type).toBe("pong");
  });

  test("maps error frames (even with lost id) to HerdrError", async () => {
    const srv = fakeServer((_line, write) => {
      write(JSON.stringify({ id: "", error: { code: "invalid_request", message: "missing field" } }) + "\n");
    });
    cleanup.push(srv.stop);
    const client = new HerdrClient(srv.socketPath);
    expect(client.request("agent.get")).rejects.toThrow(HerdrError);
  });

  test("connection refused surfaces as HerdrError, later requests unaffected", async () => {
    const client = new HerdrClient("/nonexistent/herdr.sock");
    expect(client.request("ping")).rejects.toThrow(HerdrError);
    const srv = fakeServer((line, write) => {
      const req = JSON.parse(line);
      write(JSON.stringify({ id: req.id, result: { type: "pong" } }) + "\n");
    });
    cleanup.push(srv.stop);
    const client2 = new HerdrClient(srv.socketPath);
    const res = await client2.request<{ type: string }>("ping");
    expect(res.type).toBe("pong");
  });

  test("times out when the server never replies", async () => {
    const srv = fakeServer(() => {});
    cleanup.push(srv.stop);
    const client = new HerdrClient(srv.socketPath);
    expect(client.request("ping", {}, { timeoutMs: 200 })).rejects.toThrow(/timed out/);
  });
});

describe("HerdrClient.subscribe", () => {
  test("receives pushed events after ack; onClose on server drop", async () => {
    let pushEvent: ((s: string) => void) | undefined;
    const srv = fakeServer((line, write) => {
      const req = JSON.parse(line);
      expect(req.method).toBe("events.subscribe");
      expect(req.params.subscriptions[0].pane_id).toBe("w1:p1");
      write(JSON.stringify({ id: req.id, result: { type: "subscription_started" } }) + "\n");
      pushEvent = write;
    });
    cleanup.push(srv.stop);
    const client = new HerdrClient(srv.socketPath);
    const events: string[] = [];
    let closed = false;
    const handle = client.subscribe(
      [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      (e) => events.push(`${e.event}:${e.data.agent_status}`),
      () => {
        closed = true;
      },
    );
    await Bun.sleep(100);
    expect(pushEvent).toBeDefined();
    pushEvent!(
      JSON.stringify({ event: "pane.agent_status_changed", data: { pane_id: "w1:p1", agent_status: "idle" } }) + "\n",
    );
    // split frame across two writes to exercise line buffering
    const frame = JSON.stringify({ event: "pane.exited", data: { pane_id: "w1:p1" } }) + "\n";
    pushEvent!(frame.slice(0, 10));
    await Bun.sleep(20);
    pushEvent!(frame.slice(10));
    await Bun.sleep(100);
    expect(events).toEqual(["pane.agent_status_changed:idle", "pane.exited:undefined"]);
    srv.stop();
    await Bun.sleep(100);
    expect(closed).toBe(true);
    handle.close();
  });

  test("subscribe error ack triggers onClose with error", async () => {
    const srv = fakeServer((line, write) => {
      const req = JSON.parse(line);
      write(JSON.stringify({ id: req.id, error: { code: "invalid_request", message: "missing field pane_id" } }) + "\n");
    });
    cleanup.push(srv.stop);
    const client = new HerdrClient(srv.socketPath);
    const err = await new Promise<Error | undefined>((resolve) => {
      client.subscribe([{ type: "pane.agent_status_changed" }], () => {}, resolve);
    });
    expect(err).toBeInstanceOf(HerdrError);
  });
});
