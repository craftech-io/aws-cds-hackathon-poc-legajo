// The landing's texts and data (FL-089, docs/landing-spec.md §5.6): both languages carry the same keys
// and none of the words of ADR-0014 §2 (nor "evaluar"); impact shows goals with their label and only
// the numbers of §1.7; "qué es simulado" puts every service in exactly one column; the three sales
// points are the same as §1.8; no text promises "your AWS account" or a waiting list; the primary call
// to action is always "Probar la demo"; the story is drawn with the real texts of
// packages/bff/src/copy. The page itself is driven by the e2e specs.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUTTON_LABELS } from "@legajo/bff/copy/buttons";
import { supplierEmailEn } from "@legajo/bff/copy/en";
import { glossTemplate, importerGloss } from "@legajo/bff/copy/en-gloss";
import { supplierSimEn } from "@legajo/bff/copy/en-supplier-sim";
import { importerEsAR, missingDocumentsEsAR } from "@legajo/bff/copy/es-AR";
import { firmEsAR } from "@legajo/bff/copy/es-AR-firm";
import { TEMPLATES, renderTemplate } from "@legajo/bff/copy/templates";
import { describe, expect, it } from "vitest";
import { findNeutralHits } from "../../../../../scripts/lint/neutral-words";
import { CONSOLE_TOKENS_KEY } from "../../../../../scripts/landing/console-session";
import { supplierReplies } from "../../../../../scripts/landing/supplier-replies";
import { TOKENS_KEY } from "../../lib/auth/tokens";
import { CONVERSATION_IDS, ESCALATION_EMAIL, STORY, SUPPLIER_THREAD, SupplierReplies, conversation, heroMessages } from "./conversations";
import { LANDING_COPY, type LandingCopy } from "./copy";
import { DEMO_COLUMNS, DEMO_ITEM_NAMES, type DemoColumnId } from "./demo-columns";
import { IMPACT_NUMBERS, IMPACT_TILES } from "./goals";

const LANDING_DIR = fileURLToPath(new URL(".", import.meta.url));
const LANGS = ["es", "en"] as const;

/** Every key path of an object, functions included as leaves. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  if (Array.isArray(value)) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

/** Every string of a value, deep, functions called with sample arguments. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return stringsOf((value as (...args: unknown[]) => unknown)(1, 8));
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(stringsOf);
}

const conversations = CONVERSATION_IDS.map(conversation);
const storyTexts = [...stringsOf(conversations), ...stringsOf(SUPPLIER_THREAD), ESCALATION_EMAIL.subject, ...ESCALATION_EMAIL.lines];

function visibleTexts(copy: LandingCopy): string[] {
  const { labels: _labels, observation: _observation, ...own } = copy;
  return stringsOf(own);
}

describe("landing copy [FL-089]", () => {
  it("has the same keys in Spanish and English, and the same number of items in every list", () => {
    expect(keyPaths(LANDING_COPY.en)).toEqual(keyPaths(LANDING_COPY.es));
    const lists = (copy: LandingCopy) => [copy.hero.trust, copy.problem.items, copy.problem.timeline.marks, copy.guarantees.items, copy.integrations.points, copy.integrations.platforms.items, copy.capabilities.importer.items, copy.capabilities.supplier.items, copy.capabilities.firm.items].map((list) => list.length);
    expect(lists(LANDING_COPY.en)).toEqual(lists(LANDING_COPY.es));
  });

  it.each(LANGS)("carries no word of ADR-0014 §2, nor the verb 'evaluar', in %s", (lang) => {
    const texts = [...visibleTexts(LANDING_COPY[lang]), ...storyTexts];
    expect(texts.flatMap((text) => findNeutralHits(text).map((hit) => hit.word))).toEqual([]);
    expect(texts.filter((text) => /\bevalua(r|te)\b/i.test(text))).toEqual([]);
  });

  it.each(LANGS)("never says 'your AWS account', a waiting list or 'request access' (%s)", (lang) => {
    const joined = visibleTexts(LANDING_COPY[lang]).join("\n");
    expect(joined).not.toMatch(/tu cuenta de AWS|your AWS account/i);
    expect(joined).not.toMatch(/pedir acceso|request access|lista de espera|waitlist|no verificada|unverified/i);
  });

  it("keeps one primary call to action, 'Probar la demo', in the header, the hero and the closing", () => {
    expect(LANDING_COPY.es.cta.try).toBe("Probar la demo");
    expect(LANDING_COPY.en.cta.try).toBe("Try the demo");
    for (const lang of LANGS) {
      const copy = LANDING_COPY[lang];
      expect(copy.hero.primary).toBe(copy.cta.try);
      expect(copy.closing.try).toBe(copy.cta.try);
    }
    expect(LANDING_COPY.es.cta.signIn).toBe("Ingresar");
    expect(LANDING_COPY.es.cta.talk).toBe("Hablemos");
  });

  it("is Powered by Craftech and says in both languages that the data is synthetic and every name fictitious", () => {
    for (const lang of LANGS) expect(LANDING_COPY[lang].footer.product).toBe("Legajo listo · Powered by Craftech");
    expect(LANDING_COPY.es.hero.note).toMatch(/100 % sintéticos/);
    expect(LANDING_COPY.en.hero.note).toMatch(/100% synthetic/);
    expect(LANDING_COPY.es.footer.synthetic).toMatch(/ficticio/);
    expect(LANDING_COPY.en.footer.synthetic).toMatch(/fictitious/);
  });
});

describe("impact as labelled goals [FL-089]", () => {
  it("labels every tile, with at most one guarantee in code and the rest goals", () => {
    expect(IMPACT_TILES.filter((tile) => tile.kind === "guarantee")).toHaveLength(1);
    expect(IMPACT_TILES.filter((tile) => tile.kind === "goal")).toHaveLength(3);
    for (const lang of LANGS) {
      const { labels } = LANDING_COPY[lang].impact;
      expect([labels.goal, labels.guarantee, labels.assumption].every((label) => label.length > 0)).toBe(true);
    }
    expect(LANDING_COPY.es.impact.labels).toEqual({ goal: "Meta", guarantee: "Garantía en código", assumption: "Supuesto" });
  });

  it.each(LANGS)("shows only the numbers of §1.7 and no free days or USD figure (%s)", (lang) => {
    const { impact } = LANDING_COPY[lang];
    const shown = IMPACT_TILES.flatMap((tile) => {
      const text = impact.tiles[tile.id];
      return [text.value(tile.count ?? 0), text.title, text.note];
    });
    const numbers = [...[...shown, impact.lead, impact.footnote, impact.assumptions].join(" ").matchAll(/\d+/g)].map((match) => Number(match[0]));
    expect(numbers.every((value) => IMPACT_NUMBERS.includes(value))).toBe(true);
    expect([...shown, impact.assumptions].join(" ")).not.toMatch(/USD\s*\d|\d+\s*días libres|\d+\s*free days|%\s*(de ahorro|saved)/i);
  });
});

describe("what is real and what is simulated [FL-089]", () => {
  const columns = Object.keys(DEMO_COLUMNS) as DemoColumnId[];

  it("puts every service or system in exactly one column", () => {
    const all = columns.flatMap((column) => [...DEMO_COLUMNS[column]]);
    expect(new Set(all).size).toBe(all.length);
  });

  it.each(LANGS)("names in each column exactly its own items, and no 'todos'/'all' in the real one (%s)", (lang) => {
    const { demo } = LANDING_COPY[lang];
    for (const column of columns) {
      const text = demo.columns[column].text.toLowerCase();
      for (const owner of columns) {
        for (const item of DEMO_COLUMNS[owner]) {
          const named = text.includes(DEMO_ITEM_NAMES[item][lang].toLowerCase());
          expect(named, `${column} ${owner === column ? "misses" : "names"} ${item}`).toBe(owner === column);
        }
      }
    }
    expect(demo.columns.real.text).not.toMatch(/\b(todos|todo|every|all)\b/i);
    expect(demo.columns.real.text).not.toMatch(/whatsapp/i);
    expect(demo.columns.simulatedMode.text).toMatch(/WhatsApp/);
  });

  it("never presents WhatsApp as a live channel", () => {
    const sentences = [...visibleTexts(LANDING_COPY.es), ...visibleTexts(LANDING_COPY.en), ...storyTexts].flatMap((text) => text.split(/(?<=[.:;])\s+/));
    const live = sentences.filter((sentence) => /whatsapp/i.test(sentence) && /\b(en vivo|live)\b/i.test(sentence) && !/simulad|simulat/i.test(sentence));
    expect(live).toEqual([]);
  });

  it("repeats the three sales points of §1.8 under the integration diagram", () => {
    expect(LANDING_COPY.es.integrations.points).toEqual(["Sin servidores que administrar", "Conectores por contrato", "Todo por infraestructura como código"]);
    expect(LANDING_COPY.en.integrations.points).toEqual(["No servers to manage", "Contract-based connectors", "Everything as infrastructure as code"]);
  });
});

describe("story drawn with the product's texts [FL-089]", () => {
  it("draws the first request with the approved template, its four buttons and its fixed gloss", () => {
    const params = [STORY.firmName, STORY.operationNumber, STORY.vessel, STORY.etaText, missingDocumentsEsAR(STORY.missing)];
    const rendered = renderTemplate("legajo_docs_pendientes", params, "ejemplo");
    const [first] = conversation("request").messages;
    const glossParams = [STORY.firmName, STORY.operationNumber, STORY.vessel, STORY.etaText, "certificate of origin and packing list"];
    expect(first).toMatchObject({ from: "firm", source: "template", text: rendered.body, gloss: glossTemplate("legajo_docs_pendientes", glossParams) });
    expect(first?.buttons.map((button) => button.text)).toEqual(TEMPLATES.legajo_docs_pendientes.buttons.map((button) => button.text));
  });

  it("plays in the hero the request and then the delegation, with the code's texts for the taps and the confirmation", () => {
    const hero = heroMessages();
    expect(hero).toEqual([...conversation("request").messages, ...conversation("delegate").messages]);
    expect(hero[1]).toMatchObject({ from: "importer", tap: true, text: BUTTON_LABELS.SUPPLIER_SENDS.template });
    expect(hero[2]?.text).toBe(importerEsAR.contactConfirmation({ maskedEmail: "s***@sim.legajo.demo.craftech.io" }));
    expect(hero[3]).toMatchObject({ from: "importer", tap: true, text: BUTTON_LABELS.CONFIRM_CONTACT.interactive });
  });

  it("answers the tariff question with the guardrail's fixed text, the escalation template and the firm's real email", () => {
    const [question, refusal, notice] = conversation("question").messages;
    expect(question).toMatchObject({ from: "importer", tap: false });
    expect(refusal).toMatchObject({ source: "fixed", text: importerEsAR.guardrailRefusal, gloss: importerGloss.guardrailRefusal });
    expect(notice?.text).toBe(renderTemplate("legajo_escalado", [STORY.operationNumber, STORY.firmName]).body);
    expect(ESCALATION_EMAIL.subject).toBe(firmEsAR.escalationEmail({ operationNumber: "4471", importerName: STORY.importerName, supplierName: STORY.supplierName, reason: "OUT_OF_CHECKLIST", summary: "", dossierStatus: "OPEN", etaText: "20/10", documents: [], attempts: [], consoleUrl: "" }).subject);
  });

  it("marks what the model would write as an example and writes to the supplier from the operation's address", () => {
    const messages = conversations.flatMap((thread) => thread.messages);
    for (const message of messages) expect(message.source === "importer", message.text).toBe(message.from === "importer");
    expect(SUPPLIER_THREAD.map((email) => email.source)).toEqual(["agent", "simulator", "agent", "simulator"]);
    expect(SUPPLIER_THREAD[0]?.from).toBe(`${supplierEmailEn.displayName(STORY.firmName)} <${STORY.threadAddress}>`);
    expect(SUPPLIER_THREAD[1]?.body).toBe(supplierSimEn.documentsAttached({ subject: SUPPLIER_THREAD[0]?.subject ?? "", docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"], invoiceNumber: STORY.invoiceNumber, supplierName: STORY.supplierName }).body);
    for (const lang of LANGS) expect(LANDING_COPY[lang].tour.agentSample).toMatch(/ejemplo|sample/i);
  });

  it("takes the simulated supplier's replies through the generated file, never from the module with the hostile bodies", () => {
    const generated = SupplierReplies.parse(JSON.parse(readFileSync(`${LANDING_DIR}/supplier-replies.json`, "utf8")));
    expect(generated, "run npx tsx scripts/landing/supplier-replies.ts").toEqual(supplierReplies());
    for (const file of readdirSync(LANDING_DIR, { recursive: true, encoding: "utf8" }).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))) {
      expect(readFileSync(`${LANDING_DIR}/${file}`, "utf8"), file).not.toMatch(/from\s+["'][^"']*en-supplier-sim["']/);
    }
  });

  it("plants a local capture's session where the console reads it", () => {
    expect(CONSOLE_TOKENS_KEY).toBe(TOKENS_KEY);
  });

  it("formats the reader's weights in each language", () => {
    expect(LANDING_COPY.es.kg(STORY.grossWeightKg.found)).toBe("12.480 kg");
    expect(LANDING_COPY.en.kg(STORY.grossWeightKg.expected)).toBe("12,840 kg");
  });
});
