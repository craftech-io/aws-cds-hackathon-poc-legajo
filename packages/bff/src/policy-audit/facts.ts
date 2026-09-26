// The facts of check (b) as they were when a message went out (reevaluate.ts, time-rules.ts): the
// rows whose dated histories decide the opt-in and supplier rules, the business hours of each side
// (Buenos Aires with the national holidays of `Reference`; the supplier's zone) and the
// counterpart's messages around the send, across operations, for the frequency and 24-hour rules.
import type { Connector } from "../connector/index";
import { contactCounterpartKey, importerCounterpartKey } from "../connector/keys";
import type { Decision } from "../domain/audit";
import type { Message } from "../domain/conversations";
import type { Operation } from "../domain/operations";
import { type BusinessHours, argentinaBusinessHours, supplierBusinessHours } from "../services/business-hours";
import { holidayCalendar } from "../services/holidays";
import type { SendFacts } from "./reevaluate";

/** How far back the counterpart's messages are read: a local day plus the 24-hour window, with margin. */
const HISTORY_LOOKBACK_MS = 48 * 3_600_000;

/** Reads the calendar of Buenos Aires once per run, whatever how many messages need it. */
export function importerHoursReader(data: Pick<Connector, "reference">): () => Promise<BusinessHours> {
  let hours: Promise<BusinessHours> | undefined;
  return () =>
    (hours ??= data.reference.listHolidays("AR").then(
      (rows) => argentinaBusinessHours(holidayCalendar("AR", rows)),
      (error: unknown) => {
        // A failed read is not kept: the next message tries again.
        hours = undefined;
        throw error;
      },
    ));
}

function counterpartKeyOf(message: Message): string | undefined {
  if (message.counterpart === "IMPORTER" && message.importerId !== undefined) return importerCounterpartKey(message.importerId);
  if (message.counterpart === "SUPPLIER" && message.contactId !== undefined) return contactCounterpartKey(message.contactId);
  return undefined;
}

async function historyOf(data: Connector, message: Message): Promise<Message[] | undefined> {
  const key = counterpartKeyOf(message);
  if (key === undefined) return undefined;
  const sentAt = Date.parse(message.sentAtSim);
  // `toSim` is exclusive: one millisecond past the send keeps the messages of the same instant.
  return data.conversations.listCounterpartMessages(key, { fromSim: new Date(sentAt - HISTORY_LOOKBACK_MS).toISOString(), toSim: new Date(sentAt + 1).toISOString() });
}

export interface FactsInput {
  readonly data: Connector;
  readonly operation: Operation;
  readonly message: Message;
  /** The ALLOW decision of the send, when there is one (its trigger tells a reply from a proactive send). */
  readonly allow: Decision | undefined;
  readonly importerHours: () => Promise<BusinessHours>;
}

export async function sendFactsOf(input: FactsInput): Promise<SendFacts> {
  const { data, operation, message } = input;
  const toImporter = message.channel === "WHATSAPP" && message.counterpart === "IMPORTER";
  const toSupplier = message.channel === "EMAIL" && message.counterpart === "SUPPLIER";
  const [consent, authorization, contact, supplier, importerHours, history] = await Promise.all([
    toImporter ? data.parties.getConsent(operation.importerId) : undefined,
    toSupplier ? data.parties.getAuthorization(operation.importerId, operation.supplierId) : undefined,
    toSupplier && message.contactId !== undefined ? data.parties.findContact(operation.supplierId, message.contactId) : undefined,
    toSupplier ? data.parties.findSupplier(operation.supplierId) : undefined,
    message.counterpart === "IMPORTER" ? input.importerHours() : undefined,
    historyOf(data, message),
  ]);
  return {
    message,
    operation,
    answersImporter: input.allow?.trigger === "IMPORTER_MESSAGE",
    ...(consent === undefined ? {} : { consent }),
    ...(authorization === undefined ? {} : { authorization }),
    ...(contact === undefined ? {} : { contact }),
    ...(supplier === undefined ? {} : { supplierHours: supplierBusinessHours(supplier.timezone) }),
    ...(importerHours === undefined ? {} : { importerHours }),
    ...(history === undefined ? {} : { history }),
  };
}
