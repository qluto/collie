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

/**
 * Which local repo an issue is about, and how we knew.
 *
 * One Linear workspace is not one repo, and often one TEAM is not either — a
 * single team's board can cover everything a person works on. So the answer is
 * a chain, most specific first, and every step accepts either an explicit
 * `[linear.repos]` entry or a plain name match against the repos collie was
 * already told about in `[repos] roots` for the new-task picker. A project
 * called "forge-neo-mobile" next to a checkout called "forge-neo-mobile"
 * therefore needs no configuration at all; the table is for when the two names
 * disagree.
 *
 *   1. a repo label on the issue           — the per-issue escape hatch
 *   2. the issue's project name             — the usual axis inside one team
 *   3. the team key                         — the whole-team default
 */
export interface RepoMatch {
  repo: string;
  /** what answered, for the sync output — a silent guess is worse than none */
  via: string;
}

function byName(name: string, table: Record<string, string>, known: string[]): string | undefined {
  const explicit = table[name];
  if (explicit) return explicit;
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return undefined;
  return known.find((repo) => (repo.split("/").at(-1) ?? "").toLowerCase() === wanted);
}

/**
 * The repo a label names, in either spelling Linear allows.
 *
 * A label GROUP is the native way and the one a person reaches for: the group
 * is called "repo" and its children are repo names. The API reports such a
 * child as `{name: "myapp", parent: {name: "repo"}}` — the group appears
 * NOWHERE in the child's own name, so prefix-matching the name can never see
 * it. The flat `repo:myapp` spelling stays supported for workspaces without
 * label groups.
 */
export function repoLabel(issue: LinearIssue, cfg: Config["linear"]): string | undefined {
  const labels = issue.labels?.nodes ?? [];
  const group = cfg.repoLabelGroup.trim().toLowerCase();
  if (group.length > 0) {
    const child = labels.find((l) => l.parent?.name.trim().toLowerCase() === group);
    if (child) return child.name.trim();
  }
  const prefix = cfg.repoLabelPrefix;
  if (prefix.length === 0) return undefined;
  const hit = labels.find((l) => l.name.toLowerCase().startsWith(prefix.toLowerCase()));
  return hit?.name.slice(prefix.length).trim();
}

/** How the repo label would be written, for a skip reason a human can act on. */
function labelAxis(cfg: Config["linear"]): string {
  return cfg.repoLabelGroup ? `${cfg.repoLabelGroup}/…` : cfg.repoLabelPrefix;
}

export function resolveRepo(
  issue: LinearIssue,
  cfg: Config["linear"],
  knownRepos: string[],
): RepoMatch | null {
  const labelled = repoLabel(issue, cfg);
  if (labelled) {
    const repo = byName(labelled, cfg.repos, knownRepos);
    // A repo label that resolves to nothing is a typo worth reporting, not a
    // reason to quietly fall through to the team's default repo.
    return repo ? { repo, via: `label ${labelled}` } : null;
  }
  // A project that maps to nothing DOES fall through, unlike the label above:
  // a `repo:` label is an instruction naming a repo, and ignoring it would be
  // wrong, while a project is just how the board is organised. A team entry is
  // therefore what it looks like — "everything else goes here" — and `via`
  // reports which rung answered so the fallback is never invisible.
  const project = issue.project?.name;
  if (project) {
    const repo = byName(project, cfg.repos, knownRepos);
    if (repo) return { repo, via: `project ${project}` };
  }
  const team = byName(issue.team.key, cfg.repos, knownRepos);
  return team ? { repo: team, via: `team ${issue.team.key}` } : null;
}

export interface ImportEntry {
  action: "import";
  issue: LinearIssue;
  repo: string;
  /** which rung of the chain answered */
  via: string;
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
  knownRepos: string[] = [],
  /** injected so this module stays pure; sync passes core's repoProblem */
  checkRepo: (repo: string) => string | null = () => null,
): PlanEntry[] {
  return issues.map((issue): PlanEntry => {
    if (imported.has(issue.id)) {
      return { action: "skip", issue, reason: "already imported" };
    }
    if (!isUnstarted(issue.state)) {
      return { action: "skip", issue, reason: `state "${issue.state.name}" is already under way` };
    }
    const match = resolveRepo(issue, cfg, knownRepos);
    if (!match) {
      const tried = [repoLabel(issue, cfg), issue.project?.name, issue.team.key].filter(Boolean);
      return {
        action: "skip",
        issue,
        reason: `no repo named ${tried.join(" / ")} (${labelAxis(cfg)} label, project, team) — add it to [linear.repos] or rename to match a checkout`,
      };
    }
    // An entry in [linear.repos] can name a checkout that has since moved.
    // Catching it here makes it a reported skip instead of an import that
    // fails at 2am, which is the same promise the capture form makes.
    const unusable = checkRepo(match.repo);
    if (unusable) {
      return { action: "skip", issue, reason: `repo ${match.repo} ${unusable} (${match.via})` };
    }
    return {
      action: "import",
      issue,
      repo: match.repo,
      via: match.via,
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
