import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { repoProblem } from "@collie/core";
import type { TaskSize } from "@collie/core";
import { JpTextInput } from "../jpTextInput.tsx";

const MAX_VISIBLE_CANDIDATES = 8;

// Fixed overlay geometry (1-indexed screen cells) for hardware-cursor
// placement: row 1 header, row 2 box border, row 3 "New task", row 4 repo,
// row 5 title; the value starts after "│ " (2 cells) + a 12-cell label.
export const INPUT_COL = 15;
export const REPO_ROW = 4;
export const TITLE_ROW = 5;

export interface NewTaskDraft {
  repo: string;
  title: string;
  size: TaskSize;
  /** undefined = whatever config (or claude itself) defaults to */
  model?: string;
}

const SIZES: TaskSize[] = ["S", "M", "L"];

/**
 * Four-question capture: where, what, how big, on which model. Everything else (worktree,
 * permission mode, priority) is a config default — a toss-in must cost under
 * ten seconds. On submit the parent opens $EDITOR for the prompt body and
 * creates the task, already queued.
 */
export function NewTaskForm(props: {
  /** discovered from config repos.roots + repos of recent tasks */
  knownRepos: string[];
  /** injectable so the view can be rendered without touching a filesystem */
  checkRepo?: (repo: string) => string | null;
  /** offered after "(default)"; config's defaults.model_choices */
  modelChoices?: string[];
  onSubmit: (draft: NewTaskDraft) => void;
  onCancel: () => void;
}): React.JSX.Element {
  // 0 repo, 1 title, 2 size, 3 model
  const [step, setStep] = useState(0);
  const [repo, setRepo] = useState("");
  const [repoSel, setRepoSel] = useState(0); // index into candidates; -1 = free text
  const [title, setTitle] = useState("");
  const [sizeIdx, setSizeIdx] = useState(1);
  // index 0 is "(default)" — no --model flag, i.e. whatever config/claude picks
  const [modelIdx, setModelIdx] = useState(0);
  const models = useMemo(() => ["(default)", ...(props.modelChoices ?? [])], [props.modelChoices]);

  // typed text filters the known repos (case-insensitive substring on the
  // whole path); arrow keys move the highlight; free text stays possible
  const candidates = useMemo(() => {
    const needle = repo.trim().toLowerCase();
    const hits = needle
      ? props.knownRepos.filter((r) => r.toLowerCase().includes(needle))
      : props.knownRepos;
    return hits.slice(0, MAX_VISIBLE_CANDIDATES);
  }, [repo, props.knownRepos]);

  // What Enter would take: the highlighted candidate, or whatever was typed.
  const chosen = repoSel >= 0 && candidates[repoSel] ? candidates[repoSel]! : repo.trim();
  const freeText = !(repoSel >= 0 && candidates[repoSel]);

  // Checked HERE, at the first field, rather than when the task is created:
  // past this point the form asks two more questions and opens $EDITOR, and
  // learning the path was wrong after writing a prompt — or worse, next
  // morning, after the dispatcher choked on it at 2am — is the disappointment
  // this whole form exists to avoid. Memoised, so it is one stat per change,
  // not one per keystroke.
  const check = props.checkRepo ?? repoProblem;
  const problem = useMemo(() => (chosen ? check(chosen) : null), [chosen]);

  const confirmRepo = () => {
    if (!chosen || problem) return; // the field simply does not let go
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
    if (step === 2) {
      if (key.leftArrow || input === "h") setSizeIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || input === "l") setSizeIdx((i) => Math.min(SIZES.length - 1, i + 1));
      if (key.return) setStep(3);
      return;
    }
    if (step === 3) {
      if (key.leftArrow || input === "h") setModelIdx((i) => Math.max(0, i - 1));
      if (key.rightArrow || input === "l") setModelIdx((i) => Math.min(models.length - 1, i + 1));
      if (key.return) {
        props.onSubmit({
          repo: repo.trim(),
          title: title.trim(),
          size: SIZES[sizeIdx]!,
          model: modelIdx > 0 ? models[modelIdx] : undefined,
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
            {problem && chosen ? (
              <Text color="red" wrap="truncate">{`${chosen} — ${problem}`}</Text>
            ) : freeText && chosen ? (
              <Text color="yellow" wrap="truncate">{`free input: ${chosen}`}</Text>
            ) : null}
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
          {choice(SIZES, sizeIdx)}
        </Text>
      )}
      {step >= 3 && (
        <Text>
          <Text dimColor>{"model:      "}</Text>
          {choice(models, modelIdx)}
        </Text>
      )}
      <Text dimColor>
        {step === 0
          ? "type to filter, ↑↓ to pick (↑ past top = free input), Enter to confirm"
          : step === 1
            ? "type + Enter"
            : step === 2
              ? "h/l size · Enter next"
              : "h/l model · Enter creates & opens $EDITOR"}
        {" · Esc cancel"}
      </Text>
    </Box>
  );
}
