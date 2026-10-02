// The landing's data (FL-089): both languages carry the same texts, the story is drawn with the real
// texts of packages/bff/src/copy, WhatsApp is never presented as a live channel, the media manifest
// names only files that exist and says where every capture was taken, and the two legal pages of the
// demo are complete in Spanish and English. The page itself is driven by e2e/landing.spec.ts.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BUTTON_LABELS } from "@legajo/bff/copy/buttons";
import { supplierEmailEn } from "@legajo/bff/copy/en";
import { glossTemplate, importerGloss } from "@legajo/bff/copy/en-gloss";
import { supplierSimEn } from "@legajo/bff/copy/en-supplier-sim";
import { importerEsAR, missingDocumentsEsAR } from "@legajo/bff/copy/es-AR";
import { TEMPLATES, renderTemplate } from "@legajo/bff/copy/templates";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CONSOLE_TOKENS_KEY } from "../../../../../scripts/landing/console-session";
import { supplierReplies } from "../../../../../scripts/landing/supplier-replies";
import { TOKENS_KEY } from "../../lib/auth/tokens";
import { CONVERSATION_IDS, CORRECTION_TARGET, STORY, SUPPLIER_THREAD, SupplierReplies, conversation } from "./conversations";
import { LANDING_COPY } from "./copy";
import { landingHref, langFromSearch } from "./lang";
import { CONSOLE_CAPTURE_IDS, LandingManifest, MEDIA_IDS, type MediaItem, mediaIdsIn, withMedia } from "./manifest";
import { SCENES, SCENE_IDS } from "./scenes";

const PUBLIC_DIR = fileURLToPath(new URL("../../../public", import.meta.url));
const LANDING_DIR = fileURLToPath(new URL(".", import.meta.url));
const CAPTURES_FILE = fileURLToPath(new URL("../../../../../scripts/landing/captures.json", import.meta.url));
const manifest = LandingManifest.parse(JSON.parse(readFileSync(`${PUBLIC_DIR}/landing/manifest.json`, "utf8")));
const Captures = z.object({ _readme: z.string(), captures: z.record(z.string(), z.object({ view: z.string().startsWith("/app/"), open: z.string().optional(), moment: z.string().min(1) }).strict()) }).strict();

/** Every key path of an object, functions included as leaves. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value).flatMap(([key, child]) => keyPaths(child, prefix ? `${prefix}.${key}` : key));
}

/** Every string of a value, deep. */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(stringsOf);
}

const conversations = CONVERSATION_IDS.map(conversation);
const everyText = [...stringsOf(LANDING_COPY), ...stringsOf(conversations), ...stringsOf(SUPPLIER_THREAD)];

describe("landing copy [FL-089]", () => {
  it("has the same keys in Spanish and English", () => {
    expect(keyPaths(LANDING_COPY.en)).toEqual(keyPaths(LANDING_COPY.es));
  });

  it("says in both languages that the data is synthetic and every name fictitious", () => {
    expect(LANDING_COPY.es.hero.note).toMatch(/100 % sintéticos/);
    expect(LANDING_COPY.en.hero.note).toMatch(/100% synthetic/);
    expect(LANDING_COPY.es.footer.synthetic).toMatch(/ficticio/);
    expect(LANDING_COPY.en.footer.synthetic).toMatch(/fictitious/);
    expect(LANDING_COPY.es.story.lead).toMatch(/ficticios/);
    expect(LANDING_COPY.en.story.lead).toMatch(/fictitious/);
  });

  it("carries the block of what is real and what is simulated, with WhatsApp only as a simulated adapter", () => {
    for (const copy of Object.values(LANDING_COPY)) {
      expect(Object.keys(copy.real.columns)).toEqual(["real", "simulated", "mocks", "data"]);
      expect(copy.real.columns.real.text).not.toMatch(/whatsapp/i);
      expect(copy.real.columns.real.text).toMatch(/SES/);
      expect(copy.real.columns.simulated.text).toMatch(/WhatsApp/);
    }
    expect(LANDING_COPY.es.real.columns.simulated.text).toMatch(/simulador/);
    expect(LANDING_COPY.en.real.columns.simulated.text).toMatch(/simulator/);
    // No sentence anywhere presents WhatsApp as live unless it says it is simulated.
    const sentences = everyText.flatMap((text) => text.split(/(?<=[.:;])\s+/));
    const liveWhatsApp = sentences.filter((sentence) => /whatsapp/i.test(sentence) && /\b(en vivo|live|real)\b/i.test(sentence) && !/simulad|simulat/i.test(sentence));
    expect(liveWhatsApp).toEqual([]);
  });

  it("is Powered by Craftech and sends visitors to the login with one button in both languages", () => {
    expect(LANDING_COPY.es.footer.made).toContain("Legajo listo · Powered by Craftech");
    expect(LANDING_COPY.en.footer.made).toContain("Legajo listo · Powered by Craftech");
    expect(LANDING_COPY.es.cta.signIn).toBe("Ingresar");
    expect(LANDING_COPY.en.cta.signIn).toBe("Sign in");
  });

  it("labels the delay figures as assumptions", () => {
    expect(LANDING_COPY.es.problem.items.map((item) => item.text).join(" ")).toMatch(/USD 160-180 por día, supuesto/);
    expect(LANDING_COPY.en.problem.items.map((item) => item.text).join(" ")).toMatch(/USD 160-180 per day, assumption/);
  });

  it("opens in English only when the link asks for it, and the switch keeps the anchor", () => {
    expect(langFromSearch(new URLSearchParams("lang=en"))).toBe("en");
    expect(langFromSearch(new URLSearchParams(""))).toBe("es");
    expect(langFromSearch(new URLSearchParams("lang=fr"))).toBe("es");
    expect(landingHref("/", "en", "#story")).toBe("/?lang=en#story");
    expect(landingHref("/", "es", "")).toBe("/");
  });
});

describe("landing story [FL-089]", () => {
  it("has one scene per step of the demo, each told in both languages", () => {
    expect(SCENES.map((scene) => scene.id)).toEqual([...SCENE_IDS]);
    for (const scene of SCENES) {
      for (const copy of Object.values(LANDING_COPY)) {
        const text = copy.story.scenes[scene.id];
        expect(text.title.length, `${scene.id} title`).toBeGreaterThan(0);
        expect(text.text.length, `${scene.id} text`).toBeGreaterThan(40);
      }
    }
  });

  it("draws the first request with the approved template, its four buttons and its fixed gloss", () => {
    const params = [STORY.firmName, STORY.operationNumber, STORY.vessel, STORY.etaText, missingDocumentsEsAR(STORY.missing)];
    const rendered = renderTemplate("legajo_docs_pendientes", params, "ejemplo");
    const [first] = conversation("request").messages;
    expect(first).toMatchObject({ from: "firm", source: "template", text: rendered.body, gloss: glossTemplate("legajo_docs_pendientes", params) });
    expect(first?.buttons.map((button) => button.text)).toEqual(TEMPLATES.legajo_docs_pendientes.buttons.map((button) => button.text));
    expect(first?.buttons.map((button) => button.url)).toEqual([true, false, false, false]);
    expect(first?.text).toContain("Operación 4471, buque Austral Aurora, arribo estimado 22/10. Faltan: certificado de origen y packing list.");
  });

  it("uses the code's fixed texts for the contact confirmation, the tapped buttons and the guardrail's answer", () => {
    const delegate = conversation("delegate").messages;
    expect(delegate[0]).toMatchObject({ from: "importer", text: BUTTON_LABELS.SUPPLIER_SENDS.template });
    expect(delegate[1]?.text).toBe(importerEsAR.contactConfirmation({ maskedEmail: "s***@sim.legajo.demo.craftech.io" }));
    expect(delegate[1]?.buttons.map((button) => button.text)).toEqual([BUTTON_LABELS.CONFIRM_CONTACT.interactive, BUTTON_LABELS.REJECT_CONTACT.interactive, BUTTON_LABELS.OTHER_CONTACT.interactive]);
    expect(delegate[2]).toMatchObject({ from: "importer", text: BUTTON_LABELS.CONFIRM_CONTACT.interactive });
    const refusal = conversation("question").messages.find((message) => message.source === "fixed");
    expect(refusal).toMatchObject({ text: importerEsAR.guardrailRefusal, gloss: importerGloss.guardrailRefusal });
    expect(conversation("noAction").messages[0]?.text).toContain(`el proveedor tiene que corregir ${CORRECTION_TARGET}`);
  });

  it("marks what the model would write as an example, in the phone and in the email thread", () => {
    const messages = conversations.flatMap((thread) => thread.messages);
    expect(messages.filter((message) => message.source === "agent").map((message) => message.from)).toEqual(["firm", "firm", "firm"]);
    for (const message of messages) expect(message.source === "importer", message.text).toBe(message.from === "importer");
    expect(SUPPLIER_THREAD.map((email) => email.source)).toEqual(["agent", "simulator", "agent", "simulator"]);
    for (const copy of Object.values(LANDING_COPY)) {
      expect(copy.phone.sources.agent).toMatch(/ejemplo|example/i);
      expect(copy.phone.caption).toMatch(/ejemplo|example/i);
      expect(copy.email.agent).toMatch(/ejemplo|example/i);
    }
  });

  it("writes to the supplier from the operation's address, as the firm via the product, and the simulator answers in the thread", () => {
    const [request, reply, correction, corrected] = SUPPLIER_THREAD;
    expect(request?.from).toBe(`${supplierEmailEn.displayName(STORY.firmName)} <${STORY.threadAddress}>`);
    expect(request?.subject).toBe(`[Op 4471] Missing documents: packing list, certificate of origin (Invoice ${STORY.invoiceNumber})`);
    expect(reply?.to).toBe(STORY.threadAddress);
    expect(reply?.body).toBe(supplierSimEn.documentsAttached({ subject: request?.subject ?? "", docTypes: ["PACKING_LIST", "CERTIFICATE_OF_ORIGIN"], invoiceNumber: STORY.invoiceNumber, supplierName: STORY.supplierName }).body);
    expect(correction?.subject).toBe("[Op 4471] Correction needed: packing list gross weight");
    expect(corrected?.subject).toBe("Re: [Op 4471] Correction needed: packing list gross weight");
  });

  it("takes the simulated supplier's replies from its module through the generated file, never the module itself", () => {
    const generated = SupplierReplies.parse(JSON.parse(readFileSync(`${LANDING_DIR}/supplier-replies.json`, "utf8")));
    expect(generated, "run npx tsx scripts/landing/supplier-replies.ts").toEqual(supplierReplies());
    // That module also carries the hostile bodies of the injection behaviour: none reaches the public page.
    for (const file of readdirSync(LANDING_DIR).filter((name) => /\.tsx?$/.test(name) && !name.endsWith(".test.ts"))) {
      expect(readFileSync(`${LANDING_DIR}/${file}`, "utf8"), file).not.toMatch(/from\s+["'][^"']*en-supplier-sim["']/);
    }
  });

  it("formats the reader's weights in each language", () => {
    expect(LANDING_COPY.es.story.kg(STORY.grossWeightKg.found)).toBe("12.480 kg");
    expect(LANDING_COPY.en.story.kg(STORY.grossWeightKg.expected)).toBe("12,840 kg");
  });
});

describe("landing media manifest [FL-089]", () => {
  it("names only files that exist under public/landing", () => {
    for (const [id, item] of Object.entries(manifest.media)) expect(existsSync(`${PUBLIC_DIR}${item.file}`), `${id}: ${item.file}`).toBe(true);
    if (manifest.video) expect(existsSync(`${PUBLIC_DIR}${manifest.video.src}`)).toBe(true);
  });

  it("has at least two pictures for the gallery to walk, each with alt and caption in both languages", () => {
    expect(mediaIdsIn(manifest).length).toBeGreaterThanOrEqual(2);
    for (const id of MEDIA_IDS) {
      for (const copy of Object.values(LANDING_COPY)) expect(copy.media.items[id].alt.length * copy.media.items[id].caption.length, id).toBeGreaterThan(0);
    }
  });

  it("says where every console capture was taken, and takes each one from scripts/landing/captures.json", () => {
    const captures = Captures.parse(JSON.parse(readFileSync(CAPTURES_FILE, "utf8"))).captures;
    expect(Object.keys(captures).sort()).toEqual([...CONSOLE_CAPTURE_IDS].sort());
    for (const id of mediaIdsIn(manifest)) {
      const item = manifest.media[id];
      if (item?.status === "capture") expect(["poc", "local"]).toContain(item.origin);
      if (item?.status === "render") expect(CONSOLE_CAPTURE_IDS).not.toContain(id);
    }
  });

  it("plants a local capture's session where the console reads it", () => {
    expect(CONSOLE_TOKENS_KEY).toBe(TOKENS_KEY);
  });

  it("refuses a capture without its origin and keeps the gallery order when a script adds a picture", () => {
    const capture: MediaItem = { file: "/landing/console-audit.png", width: 1280, height: 800, status: "capture", origin: "local" };
    expect(LandingManifest.safeParse({ version: 1, video: null, media: { "console-audit": { ...capture, origin: undefined } } }).success).toBe(false);
    expect(LandingManifest.safeParse({ version: 1, video: null, media: { "console-cash": capture } }).success).toBe(false);
    const added = withMedia(withMedia({ version: 1, video: null, media: {} }, "console-audit", capture), "console-operations", { ...capture, file: "/landing/console-operations.png", origin: "poc" });
    expect(mediaIdsIn(added)).toEqual(["console-operations", "console-audit"]);
  });
});

describe("legal pages of the demo [FL-089]", () => {
  const pages = { privacy: readFileSync(`${PUBLIC_DIR}/legal/privacy.html`, "utf8"), terms: readFileSync(`${PUBLIC_DIR}/legal/terms.html`, "utf8") };

  it("are complete in Spanish and in English, link to each other and say the data is synthetic", () => {
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).toMatch(/<html lang="es">/);
      expect(html, name).toMatch(/<section id="en" lang="en"[ >]/);
      expect(html, name).toContain('href="/legal/privacy.html"');
      expect(html, name).toContain('href="/legal/terms.html"');
      expect(html, name).toMatch(/100 % sintéticos/);
      expect(html, name).toMatch(/100% synthetic/);
      expect(html, name).toContain("Powered by");
    }
  });

  it("load nothing from a third party and run no script", () => {
    for (const [name, html] of Object.entries(pages)) {
      expect(html, name).not.toMatch(/<script/i);
      const sources = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
      for (const source of sources) expect(source.startsWith("/") || source.startsWith("#") || source === "https://craftech.io", `${name}: ${source}`).toBe(true);
    }
  });
});
