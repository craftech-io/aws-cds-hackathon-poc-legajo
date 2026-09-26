// Readers of docs/ for the contract tests of this package (never imported by runtime code): the
// enums and ids here must say exactly what the design docs say, so a change on either side fails a
// test instead of drifting.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function readDoc(path: string): string {
  return readFileSync(`${ROOT}${path}`, "utf8");
}

/** Backticked tokens of `text`, in order: "`A`, `B` (x)" → ["A", "B"]. */
export function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** Backticked tokens between the first `start` marker and the next `end` after it. */
export function tokensBetween(markdown: string, start: string, end: string): string[] {
  const from = markdown.indexOf(start);
  if (from === -1) throw new Error(`marker not found: ${start}`);
  const to = markdown.indexOf(end, from + start.length);
  if (to === -1) throw new Error(`end marker not found after ${start}: ${end}`);
  return backticked(markdown.slice(from + start.length, to));
}

/** Cells of the body rows of the markdown table whose header line starts with `header`. */
export function tableRows(markdown: string, header: string): string[][] {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.startsWith(header));
  if (start === -1) throw new Error(`table not found: ${header}`);
  const rows: string[][] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    rows.push(line.slice(1, line.endsWith("|") ? -1 : undefined).split(" | ").map((cell) => cell.trim()));
  }
  return rows;
}

/**
 * Backticked tokens of one column of a table, in row order, without repeats; with `firstOnly`, just
 * the first token of each cell ("`MILESTONE` (`timerId` = …)" → "MILESTONE").
 */
export function columnTokens(markdown: string, header: string, options: { column?: number; firstOnly?: boolean } = {}): string[] {
  const tokens = tableRows(markdown, header).flatMap((cells) => {
    const all = backticked(cells[options.column ?? 0] ?? "");
    return options.firstOnly ? all.slice(0, 1) : all;
  });
  return [...new Set(tokens)];
}

/** Values of an inline enum written as `A | B | C` or `A|B|C`, captured by the first group of `pattern`. */
export function pipeList(markdown: string, pattern: RegExp): string[] {
  const match = pattern.exec(markdown)?.[1];
  if (match === undefined) throw new Error(`list not found: ${pattern}`);
  return match.split(/\s*\\?\|\s*/).map((value) => value.replaceAll('"', "").trim());
}

/** The body of the first fenced ```json block after `marker`. */
export function jsonBlockAfter(markdown: string, marker: string): unknown {
  const from = markdown.indexOf(marker);
  const open = markdown.indexOf("```json", from);
  const close = markdown.indexOf("```", open + 7);
  if (from === -1 || open === -1 || close === -1) throw new Error(`json block not found after ${marker}`);
  return JSON.parse(markdown.slice(open + 7, close));
}
