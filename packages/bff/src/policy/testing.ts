// Fixtures for the policy tests and for the modules that call the engine: operation 4471 of the demo
// world (docs/seed-spec.md §4: importer `imp-norpampa`, supplier `sup-qingdao` in Asia/Shanghai,
// contact `ctc-qingdao-1`), all facts in force since the seed, and builders of the counterpart's
// history. Every instant is explicit: tests never depend on the machine's clock.
import type { z } from "zod";
import type { MessageKind } from "@legajo/shared";
import type { HistoryMessage, PolicyInput, PolicyMessageInput } from "./types";

/** Argentina's national holidays of the seed (docs/seed-spec.md §12). */
export const ARGENTINA_HOLIDAYS = ["2026-10-12", "2026-11-23", "2026-12-08", "2026-12-25"];

export const SEEDED_AT = "2026-09-30T12:00:00-03:00";
export const REAL_NOW = "2026-09-26T15:00:00.000Z";
export const IMPORTER_PHONE = "+5491155500101";
export const SUPPLIER_ADDRESS = "supplier-qingdao@sim.legajo.demo.craftech.io";
/** Thursday 15/10 10:00 in Buenos Aires: inside Argentina's business hours. */
export const THURSDAY_10_AR = "2026-10-15T10:00:00-03:00";
/** Friday 16/10 10:00 in Qingdao (Thursday 23:00 in Buenos Aires): inside the supplier's hours. */
export const FRIDAY_10_QINGDAO = "2026-10-16T10:00:00+08:00";

export type HistoryInput = z.input<typeof HistoryMessage>;
type Input = Omit<PolicyInput, "message" | "clock">;

export interface InputOverrides extends Partial<Input> {
  readonly message?: Partial<PolicyMessageInput>;
  /** Simulated instant of the send. */
  readonly at?: string;
  /** Real instant of the send. */
  readonly realAt?: string;
}

export const OPERATION_4471 = {
  operationId: "op-4471",
  importerId: "imp-norpampa",
  supplierId: "sup-qingdao",
  control: "AGENT",
  dossierStatus: "OPEN",
  controlHistory: [{ control: "AGENT", atSim: SEEDED_AT, by: "SEED" }],
  dossierHistory: [{ status: "OPEN", atSim: SEEDED_AT, by: "SEED" }],
} satisfies PolicyInput["operation"];

export const NORPAMPA = {
  importerId: "imp-norpampa",
  phoneE164: IMPORTER_PHONE,
  consent: { history: [{ action: "GRANTED", atSim: SEEDED_AT, by: "SEED", medium: "SIGNED_FORM", textVersion: "v1" }] },
  authorization: { authorized: true, history: [{ action: "AUTHORIZED", atSim: SEEDED_AT, by: "SEED" }] },
} satisfies NonNullable<PolicyInput["importer"]>;

export const QINGDAO = { supplierId: "sup-qingdao", timezone: "Asia/Shanghai" } satisfies NonNullable<PolicyInput["supplier"]>;

export const QINGDAO_CONTACT = {
  contactId: "ctc-qingdao-1",
  supplierId: "sup-qingdao",
  status: "ACTIVE",
  statusHistory: [{ status: "ACTIVE", atSim: SEEDED_AT, by: "SEED" }],
} satisfies NonNullable<PolicyInput["contact"]>;

function build(message: PolicyMessageInput, defaultAt: string, overrides: InputOverrides): PolicyInput {
  const { message: messageOverrides, at, realAt, ...rest } = overrides;
  return {
    message: { ...message, ...messageOverrides },
    operation: OPERATION_4471,
    importer: NORPAMPA,
    supplier: QINGDAO,
    contact: QINGDAO_CONTACT,
    history: [],
    clock: { simNow: at ?? defaultAt, realNow: realAt ?? REAL_NOW },
    modes: { email: "live", whatsapp: "simulated" },
    holidays: ARGENTINA_HOLIDAYS,
    ...rest,
  };
}

/** The milestone's `legajo_docs_pendientes` to the importer, Thursday 15/10 10:00 in Buenos Aires. */
export function toImporter(overrides: InputOverrides = {}): PolicyInput {
  return build(
    {
      channel: "WHATSAPP",
      counterpart: "IMPORTER",
      kind: "DOCS_REQUEST",
      author: "AGENT",
      to: IMPORTER_PHONE,
      template: { name: "legajo_docs_pendientes", params: ["Estudio Delta", "4471", "Austral Aurora", "22/10", "packing list, certificado de origen"] },
      trigger: "MILESTONE",
    },
    THURSDAY_10_AR,
    overrides,
  );
}

/** A free-text reply to the importer's message of `inboundAt` (the default question at 09:30). */
export function replyToImporter(overrides: InputOverrides = {}, inboundAt = "2026-10-15T09:30:00-03:00"): PolicyInput {
  return toImporter({
    history: [inbound("msg-in1", inboundAt)],
    ...overrides,
    message: { kind: "REPLY", template: undefined, text: "Sí, el certificado de origen tiene que estar firmado por la entidad emisora.", trigger: "IMPORTER_MESSAGE", ...overrides.message },
  });
}

/** The `DOCS_REQUEST` email to Qingdao, Friday 16/10 10:00 in Qingdao, with the fence's verdict. */
export function toSupplier(overrides: InputOverrides = {}): PolicyInput {
  return build(
    {
      channel: "EMAIL",
      counterpart: "SUPPLIER",
      kind: "DOCS_REQUEST",
      author: "AGENT",
      to: SUPPLIER_ADDRESS,
      contactId: "ctc-qingdao-1",
      text: "Operation 4471: please send the packing list and the certificate of origin matching invoice QBT-2026-0917 (FOB Qingdao).",
      trigger: "CONTACT_CONFIRMED",
    },
    FRIDAY_10_QINGDAO,
    { fence: { allowed: true }, ...overrides },
  );
}

/** A WhatsApp message of the importer (it opens the 24-hour window). */
export function inbound(messageId: string, atSim: string, realAt: string = REAL_NOW): HistoryInput {
  return { messageId, direction: "IN", channel: "WHATSAPP", counterpart: "IMPORTER", importerId: "imp-norpampa", status: "RECEIVED", sentAtSim: atSim, sentAtReal: realAt };
}

export interface SentOptions {
  readonly status?: HistoryInput["status"];
  readonly realAt?: string;
  readonly importerId?: string;
}

/** A WhatsApp that went out to the importer. */
export function sentToImporter(messageId: string, kind: MessageKind, atSim: string, options: SentOptions = {}): HistoryInput {
  return { messageId, direction: "OUT", channel: "WHATSAPP", counterpart: "IMPORTER", importerId: options.importerId ?? "imp-norpampa", kind, status: options.status ?? "SENT", sentAtSim: atSim, sentAtReal: options.realAt ?? REAL_NOW };
}

/** An email that went out to a supplier contact. */
export function sentToSupplier(messageId: string, kind: MessageKind, atSim: string, contactId = "ctc-qingdao-1", options: SentOptions = {}): HistoryInput {
  return { messageId, direction: "OUT", channel: "EMAIL", counterpart: "SUPPLIER", contactId, kind, status: options.status ?? "SENT", sentAtSim: atSim, sentAtReal: options.realAt ?? REAL_NOW };
}
