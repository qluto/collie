import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { showNotification } from "../src/index.ts";

/** Records every frame the notifier sends, and answers like herdr does. */
function fakeHerdr(socketPath: string, shown = true) {
  const seen: Array<Record<string, unknown>> = [];
  const server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket, chunk) {
        for (const line of chunk.toString().split("\n")) {
          if (line.trim().length === 0) continue;
          const req = JSON.parse(line);
          seen.push(req);
          socket.write(JSON.stringify({
            id: req.id,
            result: { type: "notification_show", shown, reason: shown ? "shown" : "disabled" },
          }) + "\n");
        }
      },
    },
  });
  return { seen, stop: () => server.stop(true) };
}

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup) fn();
  cleanup = [];
});

function freshHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collie-notify-"));
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("showNotification", () => {
  test("sends title/body/sound and reports what herdr answered", async () => {
    const home = freshHome();
    const sock = path.join(home, "herdr.sock");
    const srv = fakeHerdr(sock);
    cleanup.push(srv.stop);
    fs.writeFileSync(path.join(home, "config.toml"), `[herdr]\nsocket_path = "${sock}"\n`);

    const prev = process.env.COLLIE_HOME;
    process.env.COLLIE_HOME = home;
    try {
      expect(await showNotification("t-1 → done", "done")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.COLLIE_HOME;
      else process.env.COLLIE_HOME = prev;
    }
    expect(srv.seen).toHaveLength(1);
    expect(srv.seen[0]!.method).toBe("notification.show");
    expect(srv.seen[0]!.params).toEqual({ title: "collie", body: "t-1 → done", sound: "done" });
  });

  test("an unparseable config falls back to the default socket instead of going silent", async () => {
    // The toast is how a detached `collie done` reports a bad config, so it
    // must not read the socket path through the config it is complaining
    // about. DEFAULT_CONFIG resolves ~ at import time, so this needs its own
    // process with HOME pointed somewhere safe — never the live herdr socket.
    const home = freshHome();
    const collieHome = freshHome();
    fs.writeFileSync(path.join(collieHome, "config.toml"), "this is [[ not valid toml =\n");
    const sock = path.join(home, ".config", "herdr", "herdr.sock");
    fs.mkdirSync(path.dirname(sock), { recursive: true });
    const srv = fakeHerdr(sock);
    cleanup.push(srv.stop);

    const entry = path.join(import.meta.dir, "..", "src", "index.ts");
    const proc = Bun.spawn({
      cmd: ["bun", "-e", `const { showNotification } = await import(${JSON.stringify(entry)});
        process.stdout.write(String(await showNotification("boom", "request")));`],
      env: { ...process.env, HOME: home, COLLIE_HOME: collieHome },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;

    expect(out).toBe("true");
    expect(srv.seen).toHaveLength(1);
    expect(srv.seen[0]!.params).toMatchObject({ body: "boom", sound: "request" });
  });

  test("an unreachable herdr is not an error — the command still did its job", async () => {
    const home = freshHome();
    fs.writeFileSync(
      path.join(home, "config.toml"),
      `[herdr]\nsocket_path = "${path.join(home, "nope.sock")}"\n`,
    );
    const prev = process.env.COLLIE_HOME;
    process.env.COLLIE_HOME = home;
    try {
      expect(await showNotification("orphan")).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.COLLIE_HOME;
      else process.env.COLLIE_HOME = prev;
    }
  });
});
