import React from "react";
import { Box, Text } from "ink";
import { configPath, loadConfig } from "@collie/core";
import type { Config } from "@collie/core";
import { padToWidth, truncateToWidth } from "../cursor.ts";

/** Width of the emoji+name column every value lines up against. */
const LABEL_W = 12;

interface Section {
  label: string;
  /** first line sits next to the label, the rest are continuations */
  lines: string[];
}

const M = (tokens: number): string => `${(tokens / 1e6).toFixed(0)}M`;

/**
 * The config as sections rather than one wall of key=value: the eye should
 * land on "which gate am I looking at" first and the numbers second. Order
 * follows the dispatcher's own tick — when it may run, how much it may run,
 * then what it runs with.
 */
function sectionsOf(c: Config): Section[] {
  const windows =
    c.schedule.windows.map((w) => `${w.start}-${w.end} ${w.mode}`).join(" · ") || "(no windows)";
  const presence = c.presence.enabled
    ? [
        `on · idle < ${c.presence.idleThresholdMin}min = present → every window capped at ${c.presence.whenPresent}`,
        `other agents count: ${c.presence.respectOtherAgents ? "yes" : "no"} · absent upgrade: ${c.presence.absentUpgrade ? "on" : "off"}`,
      ]
    : ["off · the schedule decides alone"];
  const burn = c.quota.burnDown.enabled
    ? `burn-down on · within ${c.quota.burnDown.windowMin}min of the reset, session cap ×${c.quota.burnDown.fraction}`
    : "burn-down off";

  return [
    { label: "🕐 schedule", lines: [windows, `outside every window: ${c.schedule.defaultMode}`] },
    { label: "🧍 presence", lines: presence },
    {
      label: "🚦 dispatch",
      lines: [
        `wip ${c.dispatch.wipLimit} running · ${c.dispatch.askingLimit} unanswered questions · ${c.dispatch.maxAttempts} attempts`,
        `tick ${c.dispatch.pollIntervalSec}s · idle grace ${c.dispatch.idleGraceMin}min · ready timeout ${c.dispatch.readyTimeoutSec}s`,
      ],
    },
    {
      label: "📊 quota",
      lines: [
        `session cap: full ×${c.quota.fractionFull} / conservative ×${c.quota.fractionConservative} · week ×${c.quota.weekFraction}`,
        burn,
        `ccusage fallback: block ${M(c.quota.blockBudgetTokens)} · week ${M(c.quota.weekBudgetTokens)} · S/M/L ${M(c.quota.sizeEstimateTokens.S)}/${M(c.quota.sizeEstimateTokens.M)}/${M(c.quota.sizeEstimateTokens.L)} · cons max ${c.quota.conservativeMaxSize}`,
      ],
    },
    {
      label: "🌱 defaults",
      lines: [
        `permission ${c.defaults.permissionMode} · worktree ${c.defaults.worktree ? "on" : "off"} · done ${c.done.close ? "closes the pane" : "leaves the pane"}`,
        c.defaults.worktreeRoot,
      ],
    },
    { label: "🐕 herdr", lines: [c.herdr.socketPath] },
    {
      label: "📁 repos",
      lines: [c.repos.roots.length ? c.repos.roots.join(" · ") : "(no roots configured)"],
    },
  ];
}

/** A rendered row: the label column (blank on continuations) and its value. */
interface Row {
  label: string;
  text: string;
  /** continuation lines carry the detail, dimmer than the section's first line */
  cont: boolean;
}

/** Section lines as rows, with blank separators only when they fit. */
function layout(sections: Section[], budget: number, width: number): Array<Row | null> {
  const value = width - LABEL_W;
  const build = (spaced: boolean): Array<Row | null> => {
    const out: Array<Row | null> = [];
    sections.forEach((s, i) => {
      if (spaced && i > 0) out.push(null); // blank separator
      s.lines.forEach((line, li) => {
        out.push({
          label: li === 0 ? padToWidth(s.label, LABEL_W) : " ".repeat(LABEL_W),
          text: truncateToWidth(line, value),
          cont: li > 0,
        });
      });
    });
    return out;
  };
  const spaced = build(true);
  if (spaced.length <= budget) return spaced;
  const packed = build(false);
  if (packed.length <= budget) return packed;
  // Ink cannot scroll: say what fell off rather than dropping it silently.
  const kept = packed.slice(0, Math.max(0, budget - 1));
  const lost = packed.length - kept.length;
  return [...kept, { label: "", text: `… +${lost} lines — e opens the file`, cont: true }];
}

export function ConfigView(props: { columns?: number; rows?: number }): React.JSX.Element {
  const width = (props.columns ?? process.stdout.columns ?? 80) - 2;
  const rows = props.rows ?? process.stdout.rows ?? 24;

  let config: Config | null = null;
  let error: string | null = null;
  try {
    config = loadConfig();
  } catch (err) {
    error = (err as Error).message;
  }

  // header (title + path + blank) and the footer (blank + hint) are fixed
  const body = config ? layout(sectionsOf(config), Math.max(1, rows - 5), width) : [];

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Text bold>{"⚙️  Config"}</Text>
        <Text dimColor>{truncateToWidth(`   ${configPath()}`, width - 10)}</Text>
      </Box>
      <Text> </Text>
      {error !== null ? (
        <Text color="red">{truncateToWidth(error, width)}</Text>
      ) : (
        body.map((row, i) =>
          row === null ? (
            <Text key={i}> </Text>
          ) : (
            <Box key={i}>
              <Text bold>{row.label}</Text>
              <Text dimColor={row.cont}>{row.text}</Text>
            </Box>
          ),
        )
      )}
      <Text> </Text>
      <Box>
        <Text color="cyan">{truncateToWidth("e", width)}</Text>
        <Text dimColor>
          {truncateToWidth(" edit in $EDITOR — the dispatcher reloads on its next tick", width - 1)}
        </Text>
      </Box>
    </Box>
  );
}
