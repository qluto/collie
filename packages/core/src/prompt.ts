/**
 * Drop the $EDITOR template's instruction comment. It is scaffolding for the
 * human ("Save & quit to create the task"), not something the spawned session
 * should read — and the emptiness check has to run on what remains, because
 * judging by line count rejected real prompts typed on the line right after
 * the comment.
 */
export function stripPromptTemplate(raw: string): string {
  return raw.replace(/^﻿?\s*<!--[\s\S]*?-->[ \t]*\r?\n?/, "").trim();
}
