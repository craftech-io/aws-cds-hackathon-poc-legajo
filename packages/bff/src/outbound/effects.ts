// What a send that went out leaves in the dossier (docs/flows-catalog.md FL-007, FL-012, FL-022,
// FL-024, FL-028), applied once the transport took it (deliver.ts), never for a refused or deferred
// one (a deferred send applies them when its timer delivers it):
//
//   requested   a `DOCS_REQUEST` or `REMINDER` naming documents: each one's `requestedFrom` is the
//               party it went to (IMPORTER by WhatsApp, SUPPLIER by email) and `lastRequestedAtSim`
//   attempts    a `CORRECTION_REQUEST` naming observations: each OPEN one counts its attempt and
//               becomes CORRECTION_REQUESTED (intake/attempts.ts, the two-attempt rule's input)
//   reminder    a `REMINDER` to a supplier contact: the contact's `lastReminderAt`
//
// The message already reached the party, so none of these may turn the send into a failure (a failed
// send invites a second one). Each effect reads again what it writes and skips what is already there,
// so a version CONFLICT with another writer (DocumentIntake, ChannelEvents) is retried from a fresh
// read; whatever still fails is logged and counted (`OutboundEffectFailed`) and the send stays SENT.
import { ConnectorError, type DocType, type Party } from "@legajo/shared";
import { countMetric } from "../channels/adapter";
import type { Actor } from "../domain/common";
import { recordCorrectionRequest } from "../intake/attempts";
import type { Logger } from "../lib/log";
import type { SendContext } from "./context";
import type { OutboundDeps } from "./deps";
import type { OutboundRequest } from "./types";

export const OUTBOUND_EFFECT_FAILED = "OutboundEffectFailed";

/** Writers racing on one row: read again and retry. */
const EFFECT_ATTEMPTS = 3;

const REQUEST_KINDS = new Set<OutboundRequest["kind"]>(["DOCS_REQUEST", "REMINDER"]);

type EffectName = "requested" | "attempts" | "reminder";

async function markRequested(deps: Pick<OutboundDeps, "data">, operationId: string, docTypes: readonly DocType[], party: Party, atSim: string): Promise<void> {
  for (const docType of new Set(docTypes)) {
    const document = await deps.data.documents.getDocument(operationId, docType);
    if (document.status === "VALID") continue;
    if (document.requestedFrom === party && document.lastRequestedAtSim !== undefined && Date.parse(document.lastRequestedAtSim) >= Date.parse(atSim)) continue;
    await deps.data.documents.updateDocument(operationId, docType, { requestedFrom: party, lastRequestedAtSim: atSim }, document.version);
  }
}

async function bestEffort(log: Logger, effect: EffectName, meta: Readonly<Record<string, unknown>>, apply: () => Promise<unknown>): Promise<void> {
  for (let attempt = 1; attempt <= EFFECT_ATTEMPTS; attempt += 1) {
    try {
      await apply();
      return;
    } catch (error) {
      const conflict = error instanceof ConnectorError && error.code === "CONFLICT";
      if (conflict && attempt < EFFECT_ATTEMPTS) continue;
      log.error("outbound.effect_failed", { ...meta, effect, attempts: attempt, error });
      countMetric(log, OUTBOUND_EFFECT_FAILED, { effect, kind: meta.kind });
      return;
    }
  }
}

export interface SentEffectsInput {
  readonly request: OutboundRequest;
  readonly context: SendContext;
  readonly sentAtSim: string;
  readonly actor: Actor;
  readonly messageId: string;
  readonly log: Logger;
}

/** Never throws: a failed effect is logged and counted, the send it follows stays SENT. */
export async function applySentEffects(deps: Pick<OutboundDeps, "data" | "wallClock">, input: SentEffectsInput): Promise<void> {
  const { request, context, sentAtSim, log } = input;
  const { operationId } = context.operation;
  const refs = request.refs ?? {};
  const meta = { operationId, messageId: input.messageId, kind: request.kind };
  const docTypes = refs.docTypes ?? [];
  if (REQUEST_KINDS.has(request.kind) && docTypes.length > 0) {
    const party: Party = request.channel === "WHATSAPP" ? "IMPORTER" : "SUPPLIER";
    await bestEffort(log, "requested", meta, () => markRequested(deps, operationId, docTypes, party, sentAtSim));
  }
  const observationIds = refs.observationIds ?? [];
  if (request.kind === "CORRECTION_REQUEST" && observationIds.length > 0) {
    await bestEffort(log, "attempts", meta, () => recordCorrectionRequest(deps.data, { operationId, observationIds, atSim: sentAtSim, atReal: deps.wallClock().toISOString(), by: input.actor }));
  }
  const contact = context.contact;
  if (request.kind === "REMINDER" && request.channel === "EMAIL" && contact !== undefined) {
    await bestEffort(log, "reminder", meta, () => deps.data.parties.markContactReminder(contact.supplierId, contact.contactId, sentAtSim));
  }
}
