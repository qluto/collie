import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PermissionMode, TaskSize } from "@collie/core";
import { JpTextInput } from "../jpTextInput.tsx";

const MAX_VISIBLE_CANDIDATES = 8;

// Fixed overlay geometry (1-indexed screen cells) for hardware-cursor
// placement: row 1 header, row 2 box border, row 3 "New task", row 4 repo,
// row 5 title; the value starts after "│ " (2 cells) + a 12-cell label.
const INPUT_COL = 15;
const REPO_ROW = 4;
const TITLE_ROW = 5;

export interface NewTaskDraft {
  repo: string;
  title: string;
  size: TaskSize;
  defer: boolean;
  worktree: boolean;
  permissionMode: PermissionMode;
  queueNow: boolean;
}

const SIZES: TaskSize[] = ["S", "M", "L"];
// Safest-first; `default` is omitted (legacy alias for `manual`).
const PERMS: PermissionMode[] = ["auto", "acceptEdits", "plan", "manual", "dontAsk", "bypassPermissions"];

/**
 * Field-by-field creation form. On submit the parent opens $EDITOR for the
 * prompt body and creates the task.
 */
export function NewTaskForm(props: {
  defaults: { worktree: boolean; permissionMode: PermissionMode };
  /** discovered from config repos.roots + repos of recent tasks */
  knownRepos: string[];
  onSubmit: (draft: NewTaskDraft) => void;
  onCancel: () => void;
}): React.JSX.Element {
  // 0 repo, 1 title, 2 size, 3 defer, 4 worktree, 5 perm, 6 queueNow
  const [step, setStep] = useState(0);
  const [repo, setRepo] = useState("");
  const [repoSel, setRepoSel] = useState(0); // index into candidates; -1 = free text
  const [title, setTitle] = useState("");
  const [sizeIdx, setSizeIdx] = useState(1);
  const [defer, setDefer] = useState(false);
  const [worktree, setWorktree] = useState(props.defaults.worktree);
  // a config default of "default" (legacy alias) isn't in PERMS -> fall back to auto
  const [permIdx, setPermIdx] = useState(Math.max(0, PERMS.indexOf(props.defaults.permissionMode)));
  const [queueNow, setQueueNow] = useState(true);

  // typed text filters the known repos (case-insensitive substring on the
  // whole path); arrow keys move the highlight; free text stays possible
  const candidates = useMemo(() => {
    const needle = repo.trim().toLowerCase();
    const hits = needle
      ? props.knownRepos.filter((r) => r.toLowerCase().includes(needle))
      : props.knownRepos;
    return hits.slice(0, MAX_VISIBLE_CANDIDATES);
  }, [repo, props.knownRepos]);

  const confirmRepo = () => {
    const chosen = repoSel >= 0 && candidates[repoSel] ? candidates[repoSel]! : repo.trim();
    if (!chosen) return;
    setRepo(chosen);
    setStep(1);
  };

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (step === 0) {
      if (key.upArrow) setRepoSel((i) => Math.max(-1, i - 1));
      else if (key.downArrow) setRepoSel((i) => Math.min(candidates.length - 1, i + 1));
      // Enter is handled by TextInput.onSubmit -> confirmRepo
      return;
    }
    const toggled = input === " " || input === "h" || input === "l" || key.leftArrow || key.rightArrow;
    if (step === 2) {
      if (key.leftArrow || input === "h") setSizeIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || input === "l") setSizeIdx((i) => Math.min(SIZES.length - 1, i + 1));
      if (key.return) setStep(3);
    } else if (step === 3) {
      if (toggled) setDefer((d) => !d);
      if (key.return) setStep(4);
    } else if (step === 4) {
      if (toggled) setWorktree((w) => !w);
      if (key.return) setStep(5);
    } else if (step === 5) {
      if (key.leftArrow || input === "h") setPermIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || input === "l") setPermIdx((i) => Math.min(PERMS.length - 1, i + 1));
      if (key.return) setStep(6);
    } else if (step === 6) {
      if (toggled) setQueueNow((q) => !q);
      if (key.return) {
        props.onSubmit({
          repo: repo.trim(),
          title: title.trim(),
          size: SIZES[sizeIdx]!,
          defer,
          worktree,
          permissionMode: PERMS[permIdx]!,
          queueNow,
        });
      }
    }
  });

  const choice = (options: string[], idx: number) =>
    options.map((o, i) => (i === idx ? `[${o}]` : ` ${o} `)).join(" ");

  return (
    <Box flexDirection="column" paddingX={1} borderStyle="round" borderColor="cyan">
      <Text bold>New task</Text>
      <Box flexDirection="column">
        <Box>
          <Text dimColor>{"repo:       "}</Text>
          {step === 0 ? (
            <JpTextInput
              value={repo}
              onChange={(v) => {
                setRepo(v);
                setRepoSel(0); // retarget the top hit as the filter narrows
              }}
              onSubmit={confirmRepo}
              row={REPO_ROW}
              col={INPUT_COL}
            />
          ) : (
            <Text>{repo}</Text>
          )}
        </Box>
        {step === 0 && (
          <Box flexDirection="column" paddingLeft={12}>
            {candidates.map((r, i) => (
              <Text key={r} inverse={i === repoSel} dimColor={i !== repoSel} wrap="truncate">
                {r}
              </Text>
            ))}
            {repoSel === -1 && repo.trim() && <Text color="yellow">free input: {repo.trim()}</Text>}
            {candidates.length === 0 && !repo.trim() && (
              <Text dimColor>(no known repos — set repos.roots in config, or type a path)</Text>
            )}
          </Box>
        )}
      </Box>
      {step >= 1 && (
        <Box>
          <Text dimColor>{"title:      "}</Text>
          {step === 1 ? (
            <JpTextInput
              value={title}
              onChange={setTitle}
              onSubmit={() => title.trim() && setStep(2)}
              row={TITLE_ROW}
              col={INPUT_COL}
            />
          ) : (
            <Text>{title}</Text>
          )}
        </Box>
      )}
      {step >= 2 && (
        <Text>
          <Text dimColor>{"size:       "}</Text>
          {step === 2 ? choice(SIZES, sizeIdx) : SIZES[sizeIdx]}
        </Text>
      )}
      {step >= 3 && (
        <Text>
          <Text dimColor>{"defer:      "}</Text>
          {step === 3 ? choice(["no", "yes"], defer ? 1 : 0) : defer ? "yes" : "no"}
          {step === 3 && <Text dimColor>{"  (yes = full windows only, i.e. nights)"}</Text>}
        </Text>
      )}
      {step >= 4 && (
        <Text>
          <Text dimColor>{"worktree:   "}</Text>
          {step === 4 ? choice(["on", "off"], worktree ? 0 : 1) : worktree ? "on" : "off"}
        </Text>
      )}
      {step >= 5 && (
        <Text>
          <Text dimColor>{"permission: "}</Text>
          {step === 5 ? choice(PERMS, permIdx) : PERMS[permIdx]}
        </Text>
      )}
      {step >= 6 && (
        <Text>
          <Text dimColor>{"queue now:  "}</Text>
          {choice(["yes", "no"], queueNow ? 0 : 1)}
        </Text>
      )}
      <Text dimColor>
        {step === 0
          ? "type to filter, ↑↓ to pick (↑ past top = free input), Enter to confirm"
          : step === 1
            ? "type + Enter"
            : "h/l to choose, Enter to confirm"}
        {" · Esc cancel"}
        {step === 6 ? " · Enter opens $EDITOR for the prompt" : ""}
      </Text>
    </Box>
  );
}
