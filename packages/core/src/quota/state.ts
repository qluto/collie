import * as fs from "node:fs";
import { quotaStatePath } from "../paths.ts";
import type { QuotaState } from "../types.ts";

export function readQuotaState(): QuotaState {
  try {
    return JSON.parse(fs.readFileSync(quotaStatePath(), "utf8")) as QuotaState;
  } catch {
    return {};
  }
}

export function writeQuotaState(patch: Partial<QuotaState>): QuotaState {
  const next = { ...readQuotaState(), ...patch };
  fs.writeFileSync(quotaStatePath(), JSON.stringify(next, null, 2));
  return next;
}

/** Active hard-stop from a scraped limit hit, if any. */
export function blockedUntil(state = readQuotaState()): Date | null {
  if (!state.blockedUntil) return null;
  const t = new Date(state.blockedUntil);
  return t.getTime() > Date.now() ? t : null;
}
