import * as fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ensureDataDirs, limitsStatePath } from "../paths.ts";

/**
 * Anthropic's own view of the account's rate-limit consumption — the numbers
 * Claude Code renders in its /usage panel. ccusage can only estimate this by
 * summing raw tokens from local transcripts against a guessed ceiling; these
 * are the real percentages.
 */
export interface LimitSnapshot {
  /** 0-100 utilization of the rolling 5-hour session limit */
  sessionPct: number;
  /** 0-100, the worst of the weekly limits (overall and per-model scopes) */
  weeklyPct: number;
  /** when the session limit resets, if reported */
  sessionResetsAt?: string;
  fetchedAt: number;
}

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** The endpoint is not ours to hammer: one call per 10 minutes, cache to disk. */
export const LIMITS_TTL_MS = 10 * 60_000;
/** Past this the cached copy is too old to gate on; callers fall back to ccusage. */
const LIMITS_MAX_AGE_MS = 40 * 60_000;

/**
 * `limits[]` is the stable-looking surface: every entry carries kind/group/
 * percent. The sibling top-level keys are internal codenames (tangelo,
 * iguana_necktie, nimbus_quill…) that will churn — do not read them.
 */
interface LimitEntry {
  group?: string;
  percent?: number;
  resets_at?: string;
}

export function parseLimits(body: unknown, now: number): LimitSnapshot | null {
  const limits = (body as { limits?: LimitEntry[] } | null)?.limits;
  if (!Array.isArray(limits) || limits.length === 0) return null;

  const worst = (group: string) =>
    limits
      .filter((l) => l.group === group && typeof l.percent === "number")
      .reduce((max, l) => Math.max(max, l.percent!), 0);
  const session = limits.find((l) => l.group === "session");

  return {
    sessionPct: worst("session"),
    weeklyPct: worst("weekly"),
    sessionResetsAt: session?.resets_at,
    fetchedAt: now,
  };
}

/**
 * The live OAuth token lives in the macOS Keychain; ~/.claude/.credentials.json
 * goes stale (Claude Code refreshes the Keychain copy, not the file). collie
 * only ever READS it — refreshing would rotate the user's credentials and can
 * log them out, so an expired token means "unavailable", not "re-auth".
 */
function readAccessToken(): string | null {
  const res = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (res.status !== 0 || !res.stdout) return null;
  try {
    const oauth = (JSON.parse(res.stdout) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } })
      .claudeAiOauth;
    if (!oauth?.accessToken) return null;
    if (typeof oauth.expiresAt === "number" && oauth.expiresAt < Date.now()) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

/** Last-read snapshot; null when the cache file is missing, corrupt, or stale. */
export function readLimits(now = Date.now()): LimitSnapshot | null {
  try {
    const snap = JSON.parse(fs.readFileSync(limitsStatePath(), "utf8")) as LimitSnapshot;
    if (typeof snap.sessionPct !== "number") return null;
    return now - snap.fetchedAt > LIMITS_MAX_AGE_MS ? null : snap;
  } catch {
    return null;
  }
}

export interface RefreshResult {
  snapshot: LimitSnapshot | null;
  /** why nothing was fetched, for the log; undefined on success or a cache hit */
  skipped?: string;
}

/**
 * Fetch the real limits at most once per LIMITS_TTL_MS and persist them, so a
 * 30s dispatcher tick and the TUI share one call instead of each polling.
 */
export async function refreshLimits(now = Date.now()): Promise<RefreshResult> {
  const cached = readLimits(now);
  if (cached && now - cached.fetchedAt < LIMITS_TTL_MS) return { snapshot: cached };

  const token = readAccessToken();
  if (!token) return { snapshot: cached, skipped: "no live claude oauth token (keychain)" };

  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { snapshot: cached, skipped: `usage endpoint HTTP ${res.status}` };
    const snapshot = parseLimits(await res.json(), now);
    if (!snapshot) return { snapshot: cached, skipped: "usage endpoint returned no limits[]" };

    ensureDataDirs();
    const tmp = `${limitsStatePath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
    fs.renameSync(tmp, limitsStatePath());
    return { snapshot };
  } catch (err) {
    return { snapshot: cached, skipped: `usage fetch failed: ${(err as Error).message}` };
  }
}
