import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import type { PermissionMode, TaskSize } from "@agent-hub/core";

export interface NewTaskDraft {
  repo: string;
  title: string;
  size: TaskSize;
  worktree: boolean;
  permissionMode: PermissionMode;
  queueNow: boolean;
}

const SIZES: TaskSize[] = ["S", "M", "L"];
const PERMS: PermissionMode[] = ["acceptEdits", "default", "plan", "bypassPermissions"];

/**
 * Field-by-field creation form. On submit the parent opens $EDITOR for the
 * prompt body and creates the task.
 */
export function NewTaskForm(props: {
  defaults: { worktree: boolean; permissionMode: PermissionMode };
  recentRepos: string[];
  onSubmit: (draft: NewTaskDraft) => void;
  onCancel: () => void;
}): React.JSX.Element {
  const [step, setStep] = useState(0); // 0 repo, 1 title, 2 size, 3 worktree, 4 perm, 5 queueNow
  const [repo, setRepo] = useState(props.recentRepos[0] ?? "");
  const [title, setTitle] = useState("");
  const [sizeIdx, setSizeIdx] = useState(1);
  const [worktree, setWorktree] = useState(props.defaults.worktree);
  const [permIdx, setPermIdx] = useState(PERMS.indexOf(props.defaults.permissionMode));
  const [queueNow, setQueueNow] = useState(true);

  useInput((input, key) => {
    if (key.escape) {
      props.onCancel();
      return;
    }
    if (step === 2) {
      if (key.leftArrow || input === "h") setSizeIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || input === "l") setSizeIdx((i) => Math.min(SIZES.length - 1, i + 1));
      if (key.return) setStep(3);
    } else if (step === 3) {
      if (input === " " || input === "h" || input === "l" || key.leftArrow || key.rightArrow) setWorktree((w) => !w);
      if (key.return) setStep(4);
    } else if (step === 4) {
      if (key.leftArrow || input === "h") setPermIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || input === "l") setPermIdx((i) => Math.min(PERMS.length - 1, i + 1));
      if (key.return) setStep(5);
    } else if (step === 5) {
      if (input === " " || input === "h" || input === "l" || key.leftArrow || key.rightArrow) setQueueNow((q) => !q);
      if (key.return) {
        props.onSubmit({
          repo: repo.trim(),
          title: title.trim(),
          size: SIZES[sizeIdx]!,
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
      <Box>
        <Text dimColor>{"repo:       "}</Text>
        {step === 0 ? (
          <TextInput value={repo} onChange={setRepo} onSubmit={() => repo.trim() && setStep(1)} />
        ) : (
          <Text>{repo}</Text>
        )}
      </Box>
      {step >= 1 && (
        <Box>
          <Text dimColor>{"title:      "}</Text>
          {step === 1 ? (
            <TextInput value={title} onChange={setTitle} onSubmit={() => title.trim() && setStep(2)} />
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
          <Text dimColor>{"worktree:   "}</Text>
          {step === 3 ? choice(["on", "off"], worktree ? 0 : 1) : worktree ? "on" : "off"}
        </Text>
      )}
      {step >= 4 && (
        <Text>
          <Text dimColor>{"permission: "}</Text>
          {step === 4 ? choice(PERMS, permIdx) : PERMS[permIdx]}
        </Text>
      )}
      {step >= 5 && (
        <Text>
          <Text dimColor>{"queue now:  "}</Text>
          {choice(["yes", "no"], queueNow ? 0 : 1)}
        </Text>
      )}
      <Text dimColor>
        {step <= 1 ? "type + Enter" : "h/l to choose, Enter to confirm"} · Esc cancel
        {step === 5 ? " · Enter opens $EDITOR for the prompt" : ""}
      </Text>
    </Box>
  );
}
