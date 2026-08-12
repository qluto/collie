import { spawnSync } from "node:child_process";

/**
 * The slice of a Linear issue collie reads. Deliberately small: every field
 * here is one more thing that can change under us, and the planner
 * (`plan.ts`) is what decides anything.
 */
export interface LinearIssue {
  id: string;
  /** "ENG-42" */
  identifier: string;
  title: string;
  description?: string | null;
  url: string;
  /** 0 none, 1 urgent, 2 high, 3 normal, 4 low */
  priority?: number;
  team: { id: string; key: string };
  state: { id: string; name: string; type: string };
  /** null on an issue that belongs to no project */
  project?: { name: string } | null;
  /** every label, not just the marker: one of them may name the repo */
  labels?: { nodes?: Array<{ name: string }> };
}

export interface LinearWorkflowState {
  id: string;
  name: string;
  type: string;
  position: number;
}

export class LinearError extends Error {}

/**
 * Where the API key lives, and why not in config.toml: the Config tab renders
 * that file in full, so a key there is one screen-share away from leaking.
 * The Keychain is the same place claude's own credentials are read from, and —
 * unlike an env var — it survives launchd, which hands the dispatcher almost
 * no environment. collie only ever READS it.
 *
 *   security add-generic-password -s "collie-linear" -a "$USER" -w "lin_api_…"
 */
export const KEYCHAIN_SERVICE = "collie-linear";

export function readApiKey(): string | null {
  const fromEnv = process.env.COLLIE_LINEAR_API_KEY;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  const res = spawnSync("/usr/bin/security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (res.status !== 0 || !res.stdout) return null;
  const key = res.stdout.trim();
  return key.length > 0 ? key : null;
}

/** Overridable so tests can point at a local fake instead of the real API. */
function apiUrl(): string {
  return process.env.COLLIE_LINEAR_API_URL || "https://api.linear.app/graphql";
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message?: string }>;
}

/**
 * One GraphQL round trip. Personal API keys go in Authorization verbatim —
 * no "Bearer" prefix, which is the one thing everybody gets wrong first.
 */
export async function graphql<T>(
  key: string,
  query: string,
  variables: Record<string, unknown> = {},
  timeoutMs = 15_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new LinearError(`request failed: ${(err as Error).message}`);
  }
  if (!res.ok) {
    // 400/401 carry a body worth showing; anything else is noise at this layer
    throw new LinearError(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  const body = (await res.json()) as GraphQLResponse<T>;
  if (body.errors?.length) {
    throw new LinearError(body.errors.map((e) => e.message ?? "unknown").join("; "));
  }
  if (!body.data) throw new LinearError("response carried no data");
  return body.data;
}

// The completedAt/canceledAt null filters are the server-side half of "is this
// issue still open". Everything else — including whether the state already
// counts as started — is decided client-side in plan.ts, where it is testable
// and does not depend on Linear's filter grammar staying put.
const ISSUES_QUERY = `
query CollieIssues($label: String!, $first: Int!) {
  issues(
    first: $first
    filter: {
      labels: { name: { eq: $label } }
      completedAt: { null: true }
      canceledAt: { null: true }
    }
  ) {
    nodes {
      id identifier title description url priority
      team { id key }
      state { id name type }
      project { name }
      labels { nodes { name } }
    }
  }
}`;

/** Open issues carrying the marker label. `first` caps one poll's blast radius. */
export async function fetchLabeledIssues(
  key: string,
  label: string,
  first = 50,
): Promise<LinearIssue[]> {
  const data = await graphql<{ issues?: { nodes?: LinearIssue[] } }>(key, ISSUES_QUERY, { label, first });
  return data.issues?.nodes ?? [];
}

const STATES_QUERY = `
query CollieStates($teamId: String!) {
  team(id: $teamId) { states(first: 50) { nodes { id name type position } } }
}`;

export async function fetchWorkflowStates(key: string, teamId: string): Promise<LinearWorkflowState[]> {
  const data = await graphql<{ team?: { states?: { nodes?: LinearWorkflowState[] } } }>(
    key, STATES_QUERY, { teamId },
  );
  return data.team?.states?.nodes ?? [];
}

const UPDATE_STATE = `
mutation CollieStart($id: String!, $stateId: String!) {
  issueUpdate(id: $id, input: { stateId: $stateId }) { success }
}`;

export async function moveIssueToState(key: string, issueId: string, stateId: string): Promise<void> {
  const data = await graphql<{ issueUpdate?: { success?: boolean } }>(
    key, UPDATE_STATE, { id: issueId, stateId },
  );
  if (!data.issueUpdate?.success) throw new LinearError("issueUpdate reported no success");
}

const CREATE_COMMENT = `
mutation CollieComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) { success }
}`;

export async function commentOnIssue(key: string, issueId: string, body: string): Promise<void> {
  const data = await graphql<{ commentCreate?: { success?: boolean } }>(
    key, CREATE_COMMENT, { issueId, body },
  );
  if (!data.commentCreate?.success) throw new LinearError("commentCreate reported no success");
}
