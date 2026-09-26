// CI check: WhatsApp cannot run `live` while its entry in docs/pending.md is open (ADR-0002).
//
// Reads `infra/channel-modes.ts` (the modes are plain string literals, one per line) and
// `docs/pending.md` (the table of pending items). When `whatsapp` is "live", the "Estado" cell of
// P-01 must record its closure as docs/pending.md asks: "Cerrado el AAAA-MM-DD por <quién>".
// Anything else fails the build with the exact reason. Email is always "live".
//
// Usage: `npm run channels:check-modes` (from the repository root). Exit 1 on any violation.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type ChannelName = "email" | "whatsapp";
export type ChannelMode = "live" | "simulated";

export const MODES_FILE = "infra/channel-modes.ts";
export const PENDING_FILE = "docs/pending.md";

/** Pending item that must be closed before WhatsApp may run live. */
export const WHATSAPP_GATE = "P-01";

const MODE_LINE = /^\s*(email|whatsapp)\s*:\s*"(live|simulated)"\s*,?/gm;

export function readModes(source: string): Partial<Record<ChannelName, ChannelMode>> {
  const modes: Partial<Record<ChannelName, ChannelMode>> = {};
  for (const match of source.matchAll(MODE_LINE)) {
    modes[match[1] as ChannelName] = match[2] as ChannelMode;
  }
  return modes;
}

// The pending table: `| P-01 | Pendiente | Dueño | Estado | Qué falta |`. Returns the Estado cell.
export function pendingStatus(markdown: string, id: string): string | undefined {
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    // cells[0] is the empty string before the first pipe; the id is the first real cell.
    if (cells[1] !== id) continue;
    return cells[4];
  }
  return undefined;
}

export function isClosed(status: string): boolean {
  return /^Cerrad[oa] el \d{4}-\d{2}-\d{2} por \S.*$/.test(status.trim());
}

export function checkModes(modesSource: string, pendingMarkdown: string): string[] {
  const errors: string[] = [];
  const modes = readModes(modesSource);

  if (modes.email !== "live") errors.push(`${MODES_FILE}: email must be "live" as a plain string literal on its own line.`);
  const whatsapp = modes.whatsapp;
  if (whatsapp === undefined) {
    errors.push(`${MODES_FILE}: mode "whatsapp" not found as a plain string literal on its own line.`);
    return errors;
  }
  if (whatsapp === "simulated") return errors;

  const status = pendingStatus(pendingMarkdown, WHATSAPP_GATE);
  if (status === undefined) {
    errors.push(`${MODES_FILE}: "whatsapp" is live but ${PENDING_FILE} has no row for ${WHATSAPP_GATE}.`);
  } else if (!isClosed(status)) {
    errors.push(
      `${MODES_FILE}: "whatsapp" is live but ${WHATSAPP_GATE} in ${PENDING_FILE} is still open ` +
        `(Estado: "${status}"). The cell must read "Cerrado el <AAAA-MM-DD> por <quién>".`,
    );
  }
  return errors;
}

function main(): void {
  const cwd = process.cwd();
  const modesSource = readFileSync(resolve(cwd, MODES_FILE), "utf8");
  const pendingMarkdown = readFileSync(resolve(cwd, PENDING_FILE), "utf8");

  const errors = checkModes(modesSource, pendingMarkdown);
  if (errors.length > 0) {
    console.error(`check-modes: ${errors.length} violation(s):`);
    for (const error of errors) console.error(`  ${error}`);
    process.exit(1);
  }

  const modes = readModes(modesSource);
  const summary = (Object.keys(modes) as ChannelName[]).map((name) => `${name}=${modes[name]}`).join(" ");
  console.log(`check-modes: ok (${summary}).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
