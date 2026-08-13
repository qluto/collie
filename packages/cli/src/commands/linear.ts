import { parseArgs } from "node:util";
import {
  KEYCHAIN_SERVICE, loadConfig, readApiKey, readLinearState, syncLinear,
} from "@collie/core";

const USAGE = `collie linear <sync|status>

  sync [--dry-run]   poll Linear now, ignoring the poll interval
  status             config, key, and what has been imported so far
`;

function setupHint(): void {
  console.log("");
  console.log("  the API key is read from the keychain, never from config.toml:");
  console.log(`    security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "$USER" -w "lin_api_…"`);
}

function runStatus(): number {
  const cfg = loadConfig().linear;
  const state = readLinearState();
  const imported = Object.values(state.imported);

  console.log(`linear: ${cfg.enabled ? "enabled" : "disabled"}`);
  console.log(`  label:        ${cfg.label}`);
  console.log(`  poll:         every ${cfg.pollIntervalMin}min`);
  console.log(`  collects:     ${cfg.assignee === "me" ? "issues assigned to you" : "any assignee"}`);
  console.log(`  size:         ${cfg.size}`);
  console.log(`  start state:  ${cfg.startState || "(the team's first started state)"}`);
  console.log(`  comment back: ${cfg.comment ? "yes" : "no"}`);
  const spellings = [
    cfg.repoLabelGroup ? `"${cfg.repoLabelGroup}/…" label group` : "",
    cfg.repoLabelPrefix ? `"${cfg.repoLabelPrefix}…" label` : "",
  ].filter(Boolean);
  console.log(`  repo from:    ${spellings.length ? `${spellings.join(" or ")}, then ` : ""}project name, then team key`);
  const repos = Object.entries(cfg.repos);
  console.log(`  repo aliases: ${repos.length ? repos.map(([k, v]) => `${k} -> ${v}`).join("\n                ") : "(none — names are matched against [repos] roots)"}`);
  console.log(`  api key:      ${readApiKey() ? "found" : "MISSING"}`);
  console.log(`  last poll:    ${state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : "never"}`);
  console.log(`  imported:     ${imported.length}`);
  for (const e of imported.slice(-5)) console.log(`                ${e.ref} -> ${e.taskId}`);
  // Off by configuration is not a fault — collie is complete without Linear,
  // and saying otherwise would make `linear status` fail on every machine that
  // simply does not use it. Non-zero is reserved for "switched on and unable
  // to work", the same rule `dispatcher status` follows.
  if (cfg.enabled && !readApiKey()) {
    setupHint();
    return 1;
  }
  return 0;
}

async function runSync(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { "dry-run": { type: "boolean" } },
    allowPositionals: false,
  });
  const dryRun = values["dry-run"] === true;

  let res;
  try {
    res = await syncLinear(loadConfig(), { force: true, dryRun });
  } catch (err) {
    console.error(`linear sync failed: ${(err as Error).message}`);
    return 1;
  }
  if (res.skipped) {
    console.log(`nothing to do: ${res.skipped}`);
    if (res.skipped.startsWith("no API key")) setupHint();
    return 1;
  }

  // Skips are the output that matters: an issue labelled for collie that
  // quietly never became a task is the failure worth an evening.
  for (const e of res.entries) {
    if (e.action === "import") {
      console.log(
        `${dryRun ? "would import" : "import"}  ${e.issue.identifier}  ${e.title}  -> ${e.repo}  (via ${e.via})`,
      );
    } else {
      console.log(`skip    ${e.issue.identifier}  ${e.reason}`);
    }
  }
  for (const w of res.warnings) console.log(`warn    ${w}`);
  const imports = res.entries.filter((e) => e.action === "import").length;
  console.log(
    dryRun
      ? `${imports} would be imported, ${res.entries.length - imports} skipped (dry run: nothing written)`
      : `${res.created.length} imported, ${res.entries.length - imports} skipped`,
  );
  return 0;
}

export async function runLinearCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "sync":
      return runSync(rest);
    case "status":
      return runStatus();
    default:
      console.log(USAGE);
      return sub === undefined || sub === "--help" ? 0 : 1;
  }
}
