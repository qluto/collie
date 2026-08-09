import { describe, expect, test } from "bun:test";
import { stripPromptTemplate } from "../src/prompt.ts";

const TEMPLATE = '<!-- Prompt for "x". Save & quit to create the task. -->';

describe("stripPromptTemplate", () => {
  test("a prompt on the line right after the comment survives", () => {
    // the regression: the old line-count guard called this an empty prompt
    expect(stripPromptTemplate(`${TEMPLATE}\nfix the login bug\n`)).toBe("fix the login bug");
  });

  test("the usual shape with the blank line kept", () => {
    expect(stripPromptTemplate(`${TEMPLATE}\n\nfix the login bug\n`)).toBe("fix the login bug");
  });

  test("an untouched template is empty", () => {
    expect(stripPromptTemplate(`${TEMPLATE}\n\n`)).toBe("");
    expect(stripPromptTemplate("")).toBe("");
    expect(stripPromptTemplate("   \n\n")).toBe("");
  });

  test("multi-line bodies and later comments are left alone", () => {
    expect(stripPromptTemplate(`${TEMPLATE}\n\nline one\n\nline two\n`)).toBe("line one\n\nline two");
    // only the LEADING comment is scaffolding; markdown further down is content
    expect(stripPromptTemplate(`${TEMPLATE}\n\nsee <!-- this --> note`)).toBe("see <!-- this --> note");
  });

  test("text without a template passes through trimmed", () => {
    expect(stripPromptTemplate("  fix the login bug  \n")).toBe("fix the login bug");
  });

  test("a multi-line leading comment is dropped whole", () => {
    expect(stripPromptTemplate("<!-- line a\nline b -->\nreal prompt")).toBe("real prompt");
  });
});
