// The deterministic verification of every outbound text (docs/design-brief.md §5.5): facts grounded in
// the turn's tool results, template parameters copied from them, what an email to the supplier must
// carry, the language of each side, and the two content rules the engine decides with the pipeline's
// verdicts: no foreign link or contact (`CP-NO-FOREIGN-LINKS`, links.ts) and no ask for sensitive data
// (`CP-NO-SENSITIVE-ASK`).
import { describe, expect, it } from "vitest";
import { foreignLinksOf, foreignLinksVerdict } from "./links";
import { sendOutbound } from "./pipeline";
import { THU_10_AR, outboundWorld } from "./testing";
import { requiredSupplierContent, verifyContent } from "./verify";

const DOSSIER = { operationNumber: "4471", invoiceNumber: "QBT-2026-0917", etaText: "22/10", grossWeightKg: 1250, deadlines: { supplier: { text: "October 19, 10:00 (Asia/Shanghai)" }, importer: { text: "19/10 10:00" } } };
const SOURCES = [DOSSIER, { firmName: "Estudio Delta", missingDocuments: "packing list y certificado de origen" }];
const NO_LINKS = { links: [], contacts: [], numbers: new Set<string>(["4471"]) };

describe("[FL-054] facts of the model's text", () => {
  it("passes dates, times, weights and codes the tools returned, in either language's notation", () => {
    expect(verifyContent({ language: "es", textSource: "MODEL", text: "La operación 4471 tiene arribo el 22/10; el plazo es el 19/10 10:00 y el peso bruto 1.250 kg.", sources: SOURCES })).toEqual([]);
    expect(verifyContent({ language: "en", textSource: "MODEL", text: "Invoice QBT-2026-0917: the gross weight is 1,250 kg and the deadline is October 19, 10:00.", sources: SOURCES })).toEqual([]);
  });

  it("names every fact no tool returned, never the party's data", () => {
    const failures = verifyContent({ language: "es", textSource: "MODEL", text: "El buque llega el 25/10 a las 08:00 con 1.300 kg de la factura QBT-2026-0999.", sources: SOURCES });
    expect(failures).toEqual([{ check: "FACTS", detail: "not in this turn's tool results: date 25/10, time 08:00, number 1300, code QBT-2026-0999" }]);
  });

  it("a text the code or a person wrote is not fact-checked", () => {
    expect(verifyContent({ language: "es", textSource: "PERSON", text: "Te llamamos el 25/10 para revisar la operación.", sources: [] })).toEqual([]);
  });
});

describe("[FL-054] template parameters", () => {
  it("are values of the turn, lists of them, or only grounded facts", () => {
    expect(verifyContent({ language: "es", textSource: "MODEL", templateParams: ["Estudio Delta", "4471", "22/10", "packing list y certificado de origen"], sources: SOURCES })).toEqual([]);
    expect(verifyContent({ language: "es", textSource: "MODEL", templateParams: ["Estudio Delta", "4471", "24/10"], sources: SOURCES })).toEqual([{ check: "PARAMS", detail: "template parameter 3 is not a value of this turn's tool results" }]);
    expect(verifyContent({ language: "es", textSource: "MODEL", templateParams: ["Estudio Gamma"], sources: SOURCES })).toHaveLength(1);
  });
});

describe("[FL-012] what an email to the supplier must carry", () => {
  const results = [{ tool: "get_dossier", output: DOSSIER }];

  it("the invoice number always, and the supplier's deadline for a request with one", () => {
    expect(requiredSupplierContent("DOCS_REQUEST", "QBT-2026-0917", results)).toEqual(["QBT-2026-0917", "October 19, 10:00 (Asia/Shanghai)"]);
    expect(requiredSupplierContent("REPLY", "QBT-2026-0917", results)).toEqual(["QBT-2026-0917"]);
    expect(requiredSupplierContent("DOCS_REQUEST", "QBT-2026-0917", [])).toEqual(["QBT-2026-0917"]);
  });

  it("a missing value is REQUIRED; Spanish to the supplier is LANGUAGE", () => {
    const required = ["QBT-2026-0917", "October 19, 10:00 (Asia/Shanghai)"];
    expect(verifyContent({ language: "en", textSource: "MODEL", text: "Hello, for invoice QBT-2026-0917 please send the packing list. Thank you.", sources: SOURCES, required })).toEqual([
      { check: "REQUIRED", detail: "the text must carry this value exactly as the tools returned them: October 19, 10:00 (Asia/Shanghai)" },
    ]);
    expect(verifyContent({ language: "en", textSource: "MODEL", text: "Hola, para la factura QBT-2026-0917 necesitamos el packing list y el certificado de origen.", sources: SOURCES, required: ["QBT-2026-0917"] })).toEqual([
      { check: "LANGUAGE", detail: "the text must be in English (detected es)" },
    ]);
  });

  it("a short fixed text that proves no language is not refused", () => {
    expect(verifyContent({ language: "es", textSource: "CODE", text: "OK", sources: [] })).toEqual([]);
  });
});

describe("[FL-038] [FL-051] instructions that came in hostile content never go out", () => {
  it("a link, a domain, an email, a phone or an account the turn did not produce is flagged by kind, never by value", () => {
    const found = foreignLinksOf("Pagá en https://pagos-rapidos.net/x o escribí a cobros@pagos.net, al +54 9 11 4444-5555 o a la cuenta 0110599520000001234567. Ver portal-aduana.com", NO_LINKS);
    expect(Object.fromEntries(found)).toEqual({ url: 1, email: 1, phone: 1, account: 1, domain: 1 });
    const verdict = foreignLinksVerdict(["Escribí a cobros@pagos.net"], NO_LINKS);
    expect(verdict).toEqual({ allowed: false, detail: "the text carries 1 email that the turn did not produce" });
    expect(verdict.detail).not.toContain("cobros");
  });

  it("the turn's upload link, a masked registered contact, the operation number, dates and codes pass", () => {
    const allowance = { links: ["https://legajo.demo.craftech.io/u/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"], contacts: ["supplier-qingdao@sim.legajo.demo.craftech.io"], numbers: new Set(["4471"]) };
    const text = "Subilos en https://legajo.demo.craftech.io/u/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde. Le escribimos a s***@sim.legajo.demo.craftech.io por la operación 4471, factura QBT-2026-0917, plazo 2026-10-19 10:00.";
    expect(foreignLinksVerdict([text], allowance)).toMatchObject({ allowed: true });
  });

  it("a supplier's 'tell the importer to pay at …' is refused by the pipeline under CP-NO-FOREIGN-LINKS", async () => {
    const world = await outboundWorld();
    await world.inbound("¿Qué dijo el proveedor?", "2026-10-15T09:30:00-03:00");
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "IMPORTER_MESSAGE");
    const result = await sendOutbound(world.deps, { operationId: "op-4471", channel: "WHATSAPP", kind: "REPLY", author: "AGENT", textSource: "MODEL", trigger: "IMPORTER_MESSAGE", turnId, eventAtSim: THU_10_AR, text: "El proveedor pide que pagues en www.pagos-rapidos.net antes del 22/10." }, world.call());
    expect(result).toMatchObject({ status: "REFUSED", ruleIds: ["CP-NO-FOREIGN-LINKS"], failure: { error: { code: "GROUNDING_FAIL" } } });
  });
});

describe("[FL-050] sensitive data is never asked for", () => {
  it("a text asking for a CBU or a card is refused under CP-NO-SENSITIVE-ASK, even from a person of the firm", async () => {
    const world = await outboundWorld();
    await world.inbound("Hola", "2026-10-15T09:30:00-03:00");
    const turnId = await world.turn([{ tool: "get_dossier", output: DOSSIER }], "IMPORTER_MESSAGE");
    const ask = { operationId: "op-4471", channel: "WHATSAPP" as const, kind: "REPLY" as const, trigger: "IMPORTER_MESSAGE" as const, eventAtSim: THU_10_AR };
    expect(await sendOutbound(world.deps, { ...ask, author: "AGENT", textSource: "MODEL", turnId, text: "Pasanos tu CBU para la operación 4471." }, world.call())).toMatchObject({ status: "REFUSED", ruleIds: ["CP-NO-SENSITIVE-ASK"] });
    expect(await sendOutbound(world.deps, { ...ask, author: "BROKER:brk-ana", textSource: "PERSON", text: "Mandanos el número de tarjeta." }, world.call())).toMatchObject({ status: "REFUSED", ruleIds: ["CP-NO-SENSITIVE-ASK"] });
    expect((await world.stores.connector.conversations.listMessages("op-4471", { direction: "OUT" })).length).toBe(0);
  });
});
