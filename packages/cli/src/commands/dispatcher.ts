import { parseArgs } from "node:util";
import { dispatcherStatus, runDispatcher } from "../dispatcher/loop.ts";

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
    case "uninstall":
      console.error(`agent-hub dispatcher ${sub}: arrives in Phase 2 (launchd)`);
      return 2;
    default:
      console.error(`usage: agent-hub dispatcher run [--once] [--verbose] | status`);
      return 2;
  }
}
