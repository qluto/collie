export type HerdrAgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** One entry of agent.list (verified shape from herdr 0.7.1). */
export interface HerdrAgentInfo {
  agent: string;
  agent_status: HerdrAgentStatus;
  cwd: string;
  foreground_cwd?: string;
  focused?: boolean;
  pane_id: string;
  tab_id: string;
  terminal_id?: string;
  workspace_id: string;
  revision?: number;
}

/** Pushed event frame from events.subscribe. */
export interface HerdrEvent {
  event: string;
  data: {
    pane_id?: string;
    workspace_id?: string;
    agent?: string;
    agent_status?: HerdrAgentStatus;
    [key: string]: unknown;
  };
}

export interface HerdrSubscription {
  type: string;
  pane_id?: string;
  workspace_id?: string;
}

export class HerdrError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(`herdr: ${code}: ${message}`);
  }
}
