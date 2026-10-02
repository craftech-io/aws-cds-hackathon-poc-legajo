// The legal pages can show a placeholder only while an external pending item tracks it (docs/pending.md):
// the controller's legal name, address and privacy mailbox wait for P-06, and the URL is not shared
// while they do. Every placeholder is a `.pending` chip with its item id, in both languages; its item is
// open in docs/pending.md; and once the item is closed, a placeholder left behind fails here, before
// any deploy.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LEGAL_DIR = fileURLToPath(new URL("../../../public/legal/", import.meta.url));
const PENDING_DOC = readFileSync(fileURLToPath(new URL("../../../../../docs/pending.md", import.meta.url)), "utf8");
const PLACEHOLDER_TEXT = /pendiente de publicaci[oó]n|pending publication/i;

const pages = readdirSync(LEGAL_DIR)
  .filter((name) => name.endsWith(".html"))
  .map((name) => ({ name, html: readFileSync(`${LEGAL_DIR}${name}`, "utf8") }));

/** The state column of an item of docs/pending.md ("Abierto", "Cerrado el …"), or undefined. */
function pendingState(id: string, doc: string = PENDING_DOC): string | undefined {
  const row = doc.split("\n").find((line) => line.startsWith(`| ${id} |`));
  return row?.split("|").map((cell) => cell.trim())[4];
}

describe("[FL-127] placeholders of the legal pages", () => {
  it("marks every placeholder as a chip that names its pending item", () => {
    for (const { name, html } of pages) {
      const texts = html.split("\n").filter((line) => PLACEHOLDER_TEXT.test(line));
      for (const line of texts) expect(line, name).toMatch(/<span class="pending" data-pending="P-\d{2}">(pendiente de publicación|pending publication)<\/span>/);
    }
  });

  it("keeps a placeholder only while its item is open in docs/pending.md, so the URL is not shared with one", () => {
    const items = new Set(pages.flatMap(({ html }) => [...html.matchAll(/data-pending="(P-\d{2})"/g)].map((match) => match[1] ?? "")));
    for (const id of items) {
      const state = pendingState(id);
      expect(state, `${id} is not in docs/pending.md`).toBeDefined();
      expect(state, `${id} is closed but the legal pages still show its placeholder: fill in the published data`).not.toMatch(/^Cerrado/);
    }
  });

  it("reads the state column of an item, open or closed", () => {
    expect(pendingState("P-06", "| P-06 | Datos | CTO | Abierto | §6 |")).toBe("Abierto");
    expect(pendingState("P-06", "| P-06 | Datos | CTO | Cerrado el 2026-10-10 por CTO | §6 |")).toMatch(/^Cerrado/);
    expect(pendingState("P-09", "| P-06 | Datos | CTO | Abierto | §6 |")).toBeUndefined();
  });
});
