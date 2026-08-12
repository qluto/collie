import type { Config, TaskSize } from "../types.ts";
import type { LinearIssue, LinearWorkflowState } from "./api.ts";

/**
 * Linear's priority field, as collie queue order. Both are "lower runs first",
 * but Linear's 0 means "nobody said", which is not the same as urgent — it
 * lands with the normal ones rather than at the head of the night.
 */
const PRIORITY: Record<number, number> = { 1: 10, 2: 50, 3: 100, 4: 200 };
const NO_PRIORITY = 100;

export function queuePriority(linearPriority: number | undefined): number {
  if (linearPriority === undefined) return NO_PRIORITY;
  return PRIORITY[linearPriority] ?? NO_PRIORITY;
}

/**
 * A state the issue has not been worked on from yet. `started` is what collie
 * itself moves an issue into on import, so treating it as "not a starting
 * point" makes Linear's own board the second line of dedup: even with the
 * local index gone, an issue collie already picked up is not picked up twice.
 */
export function isUnstarted(state: { type: string }): boolean {
  return state.type === "backlog" || state.type === "unstarted" || state.type === "triage";
}

export interface ImportEntry {
  action: "import";
  issue: LinearIssue;
  repo: string;
  title: string;
  prompt: string;
  priority: number;
  size: TaskSize;
}

export interface SkipEntry {
  action: "skip";
  issue: LinearIssue;
  reason: string;
}

export type PlanEntry = ImportEntry | SkipEntry;

/**
 * The prompt body an imported issue becomes. The reference line leads so the
 * agent — and the human reading Detail — knows what it is working from before
 * the first line of description; the dispatcher's own footer is appended later
 * and does not belong here.
 */
export function issuePrompt(issue: LinearIssue): string {
  const body = (issue.description ?? "").trim();
  const head = `Linear ${issue.identifier}: ${issue.url}`;
  return body.length > 0 ? `${head}\n\n${body}\n` : `${head}\n`;
}

/**
 * What one poll would do, decided entirely from data — no network, no clock.
 *
 * Everything that could surprise a human is a `skip` carrying its reason
 * rather than a silent drop: an issue labelled for collie that never turns
 * into a task is exactly the failure someone would waste an evening on.
 */
export function planImport(
  issues: LinearIssue[],
  cfg: Config["linear"],
  imported: ReadonlySet<string>,
): PlanEntry[] {
  return issues.map((issue): PlanEntry => {
    if (imported.has(issue.id)) {
      return { action: "skip", issue, reason: "already imported" };
    }
    if (!isUnstarted(issue.state)) {
      return { action: "skip", issue, reason: `state "${issue.state.name}" is already under way` };
    }
    const repo = cfg.repos[issue.team.key];
    if (!repo) {
      return { action: "skip", issue, reason: `no repo mapped for team ${issue.team.key}` };
    }
    return {
      action: "import",
      issue,
      repo,
      title: issue.title.trim() || issue.identifier,
      prompt: issuePrompt(issue),
      priority: queuePriority(issue.priority),
      size: cfg.size,
    };
  });
}

/**
 * Which workflow state an imported issue moves to. A configured name wins
 * (exact, case-insensitive); otherwise the team's own first `started` state,
 * which is what "In Progress" is called on a default board and what a renamed
 * one still is. No match at all means leave the issue alone — moving it
 * somewhere arbitrary is worse than not moving it.
 */
export function pickStartState(
  states: LinearWorkflowState[],
  configured: string,
): LinearWorkflowState | null {
  const wanted = configured.trim().toLowerCase();
  if (wanted.length > 0) {
    return states.find((s) => s.name.trim().toLowerCase() === wanted) ?? null;
  }
  const started = states.filter((s) => s.type === "started").sort((a, b) => a.position - b.position);
  return started[0] ?? null;
}
