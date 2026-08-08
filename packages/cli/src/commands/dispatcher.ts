import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { ensureDataDirs } from "@agent-hub/core";
import { dispatcherStatus, runDispatcher } from "../dispatcher/loop.ts";

const LABEL = "com.qluto.agent-hub.dispatcher";

function plistDest(): string {
  return path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function launchctl(args: string[], opts?: { allowFail?: boolean }): string {
  try {
    // pipe stderr so expected failures (idempotent bootout) stay silent
    return execFileSync("launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if (opts?.allowFail) return "";
    throw err;
  }
}

function installLaunchd(): number {
  ensureDataDirs();
  const repo = path.resolve(import.meta.dir, "..", "..", "..", "..");
  const template = fs.readFileSync(path.join(repo, "assets", `${LABEL}.plist.template`), "utf8");
  const rendered = template
    .replaceAll("{{BUN}}", process.execPath)
    .replaceAll("{{BUN_DIR}}", path.dirname(process.execPath))
    .replaceAll("{{REPO}}", repo)
    .replaceAll("{{HOME}}", os.homedir());
  fs.mkdirSync(path.dirname(plistDest()), { recursive: true });
  fs.writeFileSync(plistDest(), rendered);

  const domain = `gui/${process.getuid!()}`;
  launchctl(["bootout", domain, plistDest()], { allowFail: true }); // idempotent reinstall
  launchctl(["bootstrap", domain, plistDest()]);
  console.log(`installed + started ${LABEL}`);
  console.log(`  plist: ${plistDest()}`);
  console.log(`  logs:  tail -f ~/.agent-hub/logs/dispatcher.log`);
  return 0;
}

function uninstallLaunchd(): number {
  launchctl(["bootout", `gui/${process.getuid!()}`, plistDest()], { allowFail: true });
  fs.rmSync(plistDest(), { force: true });
  console.log(`uninstalled ${LABEL}`);
  return 0;
}

export async function runDispatcherCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "run": {
      const { values } = parseArgs({
        args: rest,
        options: {
          once: { type: "boolean", default: false },
          verbose: { type: "boolean", default: false },
        },
      });
      return runDispatcher({ once: values.once, verbose: values.verbose });
    }
    case "status":
      return dispatcherStatus();
    case "install":
      return installLaunchd();
    case "uninstall":
      return uninstallLaunchd();
    default:
      console.error(`usage: agent-hub dispatcher run [--once] [--verbose] | status | install | uninstall`);
      return 2;
  }
}
