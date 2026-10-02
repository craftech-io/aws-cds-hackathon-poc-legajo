// `get_counterpart_profile` (docs/tool-catalog.md): what the firm knows about one party of the turn's
// operation, at the world's simulated now (ADR-0007). Addresses go out masked; the importer's phone
// never goes out at all. The WhatsApp window is measured on the world's clock: the channel is
// `simulated` until P-01, and `live` mode moves the measure to real time inside the outbound policy,
// which decides every send anyway (`CP-WA-24H`); this field only helps the model choose.
import { type DossierStatus, maskEmail, ok } from "@legajo/shared";
import { importerCounterpartKey } from "../../connector/keys";
import { authorizationActiveAt, consentActiveAt, contactStatusAt } from "../../domain/parties";
import { isBusinessOpen, nextBusinessOpening, supplierBusinessHours } from "../../services/business-hours";
import type { ToolContext, ToolImplementation, ToolResponse } from "../common/context";
import type { ToolInput } from "../common/define";
import type { OPERATIONS_TOOLS } from "./schema";
import { textAr, textInZone } from "./time-text";

type Input = ToolInput<(typeof OPERATIONS_TOOLS)["get_counterpart_profile"]>;

const WINDOW_MS = 24 * 3_600_000;

/** Dossiers the importer still has something to do in. */
const OPEN_DOSSIERS: readonly DossierStatus[] = ["OPEN", "READY_FOR_REVIEW", "REOPENED"];

/** Last WhatsApp message of the importer at or before `nowSim`, if any (only those open the window). */
async function lastImporterMessageAt(ctx: ToolContext<Input>): Promise<number | undefined> {
  const { connector, scope } = ctx;
  const messages = await connector.conversations.listCounterpartMessages(importerCounterpartKey(scope.importerId), { direction: "IN", toSim: scope.nowSim });
  const now = Date.parse(scope.nowSim);
  const instants = messages.filter((message) => message.channel === "WHATSAPP" && Date.parse(message.sentAtSim) <= now).map((message) => Date.parse(message.sentAtSim));
  return instants.length === 0 ? undefined : Math.max(...instants);
}

async function windowOf(ctx: ToolContext<Input>): Promise<{ readonly windowOpen: boolean; readonly windowClosesAtText?: string }> {
  try {
    const last = await lastImporterMessageAt(ctx);
    if (last === undefined) return { windowOpen: false };
    const closesAt = last + WINDOW_MS;
    return Date.parse(ctx.scope.nowSim) < closesAt ? { windowOpen: true, windowClosesAtText: textAr(new Date(closesAt)) } : { windowOpen: false };
  } catch (error) {
    // Without the conversation the window is reported closed: the conservative answer, the policy decides anyway.
    ctx.log.warn("tool.window_unknown", { error });
    return { windowOpen: false };
  }
}

async function importerProfile(ctx: ToolContext<Input>): Promise<ToolResponse> {
  const { connector, scope } = ctx;
  const [importer, consent, authorization, operations, window] = await Promise.all([
    connector.parties.getImporter(scope.importerId),
    connector.parties.getConsent(scope.importerId),
    connector.parties.getAuthorization(scope.importerId, scope.supplierId),
    connector.operations.listOperations(scope.firmId, { importerId: scope.importerId, clockId: scope.clockId, statuses: OPEN_DOSSIERS }),
    windowOf(ctx),
  ]);
  const optInActive = consentActiveAt(consent, scope.nowSim);
  return ok({
    importer: {
      contactFirstName: importer.contactFirstName,
      optIn: { active: optInActive, ...(optInActive && consent !== undefined ? { grantedAtText: textAr(consent.grantedAt) } : {}) },
      ...window,
      supplierContactAuthorized: authorizationActiveAt(authorization, scope.nowSim),
      otherOpenOperations: operations
        .filter((operation) => operation.operationId !== scope.operationId)
        .map((operation) => operation.operationNumber)
        .sort(),
    },
  });
}

async function supplierProfile(ctx: ToolContext<Input>): Promise<ToolResponse> {
  const { connector, scope } = ctx;
  const [supplier, contacts, profile] = await Promise.all([connector.parties.getSupplier(scope.supplierId), connector.parties.listContacts(scope.supplierId), connector.parties.getProfile(scope.supplierId)]);
  const now = new Date(Date.parse(scope.nowSim));
  const hours = supplierBusinessHours(supplier.timezone);
  const open = isBusinessOpen(now, hours);
  return ok({
    supplier: {
      name: supplier.name,
      language: supplier.language,
      timezone: supplier.timezone,
      localTimeText: textInZone(now, supplier.timezone),
      businessHoursOpenNow: open,
      ...(open ? {} : { nextBusinessOpenText: textInZone(nextBusinessOpening(now, hours), supplier.timezone) }),
      contacts: contacts
        .filter((contact) => contactStatusAt(contact, scope.nowSim) !== undefined)
        .map((contact) => {
          const status = contactStatusAt(contact, scope.nowSim) ?? contact.status;
          const confirmed = contact.confirmedAt !== undefined && Date.parse(contact.confirmedAt) <= now.getTime();
          return { contactId: contact.contactId, emailMasked: maskEmail(contact.email), status, confirmed };
        }),
      profile: {
        ...(profile?.medianReplyHours === undefined ? {} : { medianReplyHours: profile.medianReplyHours }),
        lateDocTypes: [...(profile?.lateDocTypes ?? [])],
        ...(profile?.lastBounceAt === undefined ? {} : { lastBounceAtText: textAr(profile.lastBounceAt) }),
      },
    },
  });
}

export const getCounterpartProfile: ToolImplementation<Input> = (ctx) => (ctx.input.party === "IMPORTER" ? importerProfile(ctx) : supplierProfile(ctx));
