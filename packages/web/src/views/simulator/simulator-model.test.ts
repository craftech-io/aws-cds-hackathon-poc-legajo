import { describe, expect, it } from "vitest";
import type { ConsoleClient } from "../../lib/trpc";
import { SimThread, SimulatorThreads, actionRequest, isUploadLink, runSimulatorAction } from "./simulator-api";
import { byDay, defaultThread, isTyping, pdfProblem, phoneMessages, ticksOf } from "./simulator-model";

function thread(overrides: Record<string, unknown> = {}): SimThread {
  return SimThread.parse({
    importerId: "imp-norpampa",
    importerName: "Norpampa Insumos SRL",
    contactName: "Lucía Benítez",
    phoneMasked: "+54*******0101",
    operations: [{ operationId: "op-4471", operationNumber: "4471" }],
    messages: [],
    ...overrides,
  });
}

const TEMPLATE = {
  messageId: "msg-1",
  direction: "OUT",
  operationNumber: "4471",
  kind: "DOCS_REQUEST",
  body: "Hola, te escribimos del estudio Estudio Delta. Operación 4471, buque Austral Aurora, arribo estimado 22/10. Faltan: certificado de origen y packing list. ¿Cómo seguimos?",
  template: "legajo_docs_pendientes",
  buttons: [
    { action: "UPLOAD", title: "Subir documentos", url: "https://legajo.demo.craftech.io/u/tok", glossEn: "Upload documents" },
    { action: "SUPPLIER_SENDS", title: "Los manda el proveedor", glossEn: "The supplier sends them" },
  ],
  status: "READ",
  sentAtSim: "2026-10-15T10:00:30-03:00",
  glossEn: "Hi, we are writing from Estudio Delta…",
};

describe("simulator.threads at the edge", () => {
  it("accepts the threads with templates, buttons and glosses, and refuses a malformed button", () => {
    const parsed = SimulatorThreads.parse({ threads: [thread({ messages: [TEMPLATE] })] });
    expect(parsed.threads[0]?.messages[0]?.buttons).toHaveLength(2);
    const malformed = { ...thread(), messages: [{ ...TEMPLATE, buttons: [{ action: "PAY_NOW", title: "x" }] }] };
    expect(SimulatorThreads.safeParse({ threads: [malformed] }).success).toBe(false);
  });

  it("sends only the importer and what it did: no phone, nonce or operation", () => {
    expect(actionRequest({ kind: "tapButton", input: { importerId: "imp-norpampa", messageId: "msg-1", action: "SUPPLIER_SENDS" } })).toEqual({
      kind: "tapButton",
      path: "simulator.tapButton",
      input: { importerId: "imp-norpampa", messageId: "msg-1", action: "SUPPLIER_SENDS" },
    });
    expect(actionRequest({ kind: "sendText", input: { importerId: "imp-norpampa", text: "  ¿El certificado tiene que estar firmado?  " } }).input).toEqual({ importerId: "imp-norpampa", text: "¿El certificado tiene que estar firmado?" });
    expect(() => actionRequest({ kind: "sendText", input: { importerId: "imp-norpampa", text: "hola", phone: "+5491155500101" } as never })).toThrow();
    expect(() => actionRequest({ kind: "sendText", input: { importerId: "imp-norpampa", text: "   " } })).toThrow();
  });

  it("keeps only upload links of ours: the console's origin and /u/, never another scheme or host", () => {
    expect(isUploadLink("https://legajo.demo.craftech.io/u/tok", "https://legajo.demo.craftech.io")).toBe(true);
    expect(isUploadLink("http://127.0.0.1:4180/u/tok", "http://127.0.0.1:4180")).toBe(true);
    expect(isUploadLink("https://legajo.demo.craftech.io/u/tok", undefined)).toBe(true);
    expect(isUploadLink("http://legajo.demo.craftech.io/u/tok", undefined)).toBe(false);
    expect(isUploadLink("https://elsewhere.example.org/u/tok", "https://legajo.demo.craftech.io")).toBe(false);
    expect(isUploadLink("https://legajo.demo.craftech.io/app/operations", "https://legajo.demo.craftech.io")).toBe(false);
    expect(isUploadLink("https://user:pw@legajo.demo.craftech.io/u/tok", "https://legajo.demo.craftech.io")).toBe(false);
    expect(isUploadLink("javascript:alert(1)//u/", "https://legajo.demo.craftech.io")).toBe(false);
    expect(isUploadLink("data:text/html,/u/x", undefined)).toBe(false);
    const hostile = { ...TEMPLATE, buttons: [{ action: "UPLOAD", title: "Subir documentos", url: "javascript:alert(1)" }] };
    expect(SimulatorThreads.parse({ threads: [thread({ messages: [hostile] })] }).threads[0]?.messages[0]?.buttons[0]?.url).toBeNull();
  });

  it("sends each action to its typed procedure, and nothing when the input is malformed", async () => {
    const sent: Array<{ path: string; input: unknown }> = [];
    const procedure = (path: string) => ({ mutate: async (input: unknown) => void sent.push({ path, input }) });
    const trpc = { simulator: { sendText: procedure("sendText"), tapButton: procedure("tapButton"), attachDocument: procedure("attachDocument"), markRead: procedure("markRead") } } as unknown as ConsoleClient;
    await runSimulatorAction(trpc, { kind: "markRead", input: { importerId: "imp-norpampa" } });
    await runSimulatorAction(trpc, { kind: "attachDocument", input: { importerId: "imp-norpampa", source: { kind: "SYNTHETIC", operationId: "op-4471", docType: "PACKING_LIST" } } });
    expect(() => runSimulatorAction(trpc, { kind: "sendText", input: { importerId: "imp-norpampa", text: "" } })).toThrow();
    expect(sent).toEqual([
      { path: "markRead", input: { importerId: "imp-norpampa" } },
      { path: "attachDocument", input: { importerId: "imp-norpampa", source: { kind: "SYNTHETIC", operationId: "op-4471", docType: "PACKING_LIST" } } },
    ]);
  });
});

describe("which thread opens", () => {
  const other = thread({ importerId: "imp-patagonia", importerName: "Patagonia Frío SA", operations: [{ operationId: "op-4474", operationNumber: "4474" }], unread: 2 });
  const main = thread();

  it("opens the main story's importer (operation 4471), unless the user chose another", () => {
    expect(defaultThread([other, main], undefined)?.importerId).toBe("imp-norpampa");
    expect(defaultThread([other, main], "imp-patagonia")?.importerId).toBe("imp-patagonia");
  });

  it("falls back to a thread with unread messages, then to the first", () => {
    const quiet = thread({ importerId: "imp-litoral", importerName: "Litoral Hogar SA", operations: [{ operationId: "op-4473", operationNumber: "4473" }] });
    expect(defaultThread([quiet, other], undefined)?.importerId).toBe("imp-patagonia");
    expect(defaultThread([quiet], undefined)?.importerId).toBe("imp-litoral");
    expect(defaultThread([], undefined)).toBeUndefined();
  });
});

describe("what the phone shows", () => {
  it("shows what the importer sent and only what the firm's messages that left, oldest first, by day", () => {
    const messages = [
      { ...TEMPLATE, messageId: "msg-3", status: "DEFERRED", sentAtSim: "2026-10-16T09:00:00-03:00" },
      { ...TEMPLATE, messageId: "msg-2", direction: "IN", status: "RECEIVED", buttons: [], sentAtSim: "2026-10-15T10:05:00-03:00", body: "Los manda el proveedor" },
      TEMPLATE,
    ];
    const shown = phoneMessages(thread({ messages }));
    expect(shown.map((message) => message.messageId)).toEqual(["msg-1", "msg-2"]);
    expect(byDay(shown).map((group) => group.day)).toEqual(["jue 15/10"]);
  });

  it("draws the ticks of the firm's messages: ✓ sent, ✓✓ delivered, ✓✓ read", () => {
    expect(ticksOf({ direction: "OUT", status: "SENT" })).toEqual({ symbol: "✓", read: false, label: "Enviado" });
    expect(ticksOf({ direction: "OUT", status: "DELIVERED" })).toMatchObject({ symbol: "✓✓", read: false });
    expect(ticksOf({ direction: "OUT", status: "READ" })).toMatchObject({ symbol: "✓✓", read: true, label: "Leído" });
    expect(ticksOf({ direction: "IN", status: "RECEIVED" })).toBeUndefined();
  });

  it("says the agent is writing while a turn or event of one of the thread's operations is pending", () => {
    const since = "2026-09-26T15:00:00.000Z";
    expect(isTyping(thread(), [{ kind: "EVENT", operationNumber: "4471", sinceReal: since }])).toBe(true);
    expect(isTyping(thread(), [{ kind: "MAIL", operationNumber: "4471", sinceReal: since }])).toBe(false);
    expect(isTyping(thread(), [{ kind: "TURN", operationNumber: "4474", sinceReal: since }])).toBe(false);
    expect(isTyping(thread({ typing: true }), [])).toBe(true);
  });

  it("checks a PDF of the user's own before asking for an upload URL", () => {
    expect(pdfProblem({ type: "application/pdf", size: 1_000, name: "co.pdf" })).toBeUndefined();
    expect(pdfProblem({ type: "", size: 1_000, name: "CO.PDF" })).toBeUndefined();
    expect(pdfProblem({ type: "image/png", size: 1_000, name: "co.png" })).toBe("notPdf");
    expect(pdfProblem({ type: "application/pdf", size: 10 * 1024 * 1024 + 1, name: "big.pdf" })).toBe("tooLarge");
    expect(pdfProblem({ type: "application/pdf", size: 0, name: "empty.pdf" })).toBe("tooLarge");
  });
});
