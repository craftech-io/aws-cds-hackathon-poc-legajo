// `record_consent` and `revoke_consent` (docs/tool-catalog.md, FL-001, FL-006, FL-016): the importer's
// WhatsApp opt-in with its dated history (`Parties/IMP#…/CONSENT#WHATSAPP`), which `CP-OPTIN`,
// `CP-OPTOUT` and `PolicyAudit` read at any past instant.
//
//   record   console and QA: the firm records when and how the opt-in was given (`grantedAt`, simulated
//            time of Argentina, never after the world's now nor before the consent's last change) and
//            which version of the text was shown (`copy/consent.ts`). `ACTION CONSENT_GRANTED`.
//   revoke   console and QA: the firm records an opt-out the importer gave by other means (no WhatsApp
//            goes out: the importer did not write, and no template carries a confirmation).
//            channel: the `OPT_OUT` button or an exact keyword; the opt-out confirmation (the fixed
//            text, the one WhatsApp `CP-OPTOUT` lets through) answers the importer's message, and
//            every open operation of the importer escalates `OPTED_OUT` so the firm follows up by other
//            means. Ids derive from the `wamid`: a redelivery sends and escalates nothing new.
//            `ACTION CONSENT_REVOKED`.
import { z } from "zod";
import { ConsentMedium, ConsentRecordInput, ConsentRevokeInput, MessageId, OperationId, ToolError } from "@legajo/shared";
import { channelEvent, derivedEventId } from "../../channels/adapter";
import { CONSENT_TEXT_VERSIONS } from "../../copy/consent";
import { ZonedInstant, entryAt } from "../../domain/common";
import type { Consent, Importer } from "../../domain/parties";
import { optOutConfirmationSend } from "../conversation-control/outbound-send";
import { type DirectContext, createDirectHandler } from "../operations-admin/handler-kit";
import type { ServiceDeps } from "../operations-admin/ports";

function consentView(consent: Consent) {
  return consent.revokedAt === undefined
    ? { status: "GRANTED" as const, grantedAt: consent.grantedAt, medium: consent.medium, textVersion: consent.textVersion }
    : { status: "REVOKED" as const, revokedAt: consent.revokedAt };
}

/** The importer the change is about, fenced to the caller's firm and to the world the caller named. */
async function importerOf(ctx: DirectContext<unknown>, importerId: string, clockId: string | undefined): Promise<Importer> {
  const importer = await ctx.connector.parties.getImporter(importerId);
  await ctx.fence(importer.firmId, { kind: "importer", id: importerId });
  if (clockId !== undefined && clockId !== importer.clockId) throw new ToolError("INVALID", "the importer is not of the world named", "WORLD_MISMATCH");
  return importer;
}

function lastChangeAt(consent: Consent | undefined): number | undefined {
  const last = consent?.history.at(-1);
  return last === undefined ? undefined : Date.parse(last.atSim);
}

export function recordConsentHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "record_consent",
      input: ConsentRecordInput,
      callers: ["CONSOLE", "QA"],
      async run(ctx) {
        const { input } = ctx;
        const importer = await importerOf(ctx, input.importerId, input.clockId);
        if (!(CONSENT_TEXT_VERSIONS as readonly string[]).includes(input.textVersion)) throw new ToolError("INVALID", "unknown version of the consent text", "UNKNOWN_TEXT_VERSION");
        const grantedAt = ZonedInstant.safeParse(input.grantedAt);
        if (!grantedAt.success) throw new ToolError("INVALID", "the opt-in date needs its time zone", "GRANTED_AT_ZONE");
        const world = await ctx.world(importer.clockId);
        const at = Date.parse(grantedAt.data);
        if (at > world.simNow.getTime()) throw new ToolError("INVALID", "an opt-in is never dated after the world's current time", "GRANTED_AT_FUTURE");
        const previous = lastChangeAt(await ctx.connector.parties.getConsent(importer.importerId));
        if (previous !== undefined && at < previous) throw new ToolError("INVALID", "an opt-in is never dated before the consent's last change", "GRANTED_AT_BEFORE_HISTORY");
        const consent = await ctx.connector.parties.grantConsent({
          importerId: importer.importerId,
          medium: ConsentMedium.parse(input.medium),
          textVersion: input.textVersion,
          atSim: grantedAt.data,
          atReal: ctx.now().toISOString(),
          by: ctx.actor,
        });
        await ctx.audit({
          firmId: importer.firmId,
          decision: "ACTION",
          action: "CONSENT_GRANTED",
          clockId: importer.clockId,
          atSim: world.atSim,
          refs: { importerId: importer.importerId },
          detail: { medium: consent.medium, textVersion: consent.textVersion, grantedAt: consent.grantedAt },
        });
        return { importerId: importer.importerId, consent: consentView(consent) };
      },
    },
    deps,
  );
}

/** What the channel adds when the importer opted out by WhatsApp (the button or a keyword). */
const ChannelOrigin = z
  .object({
    /** The importer's open operations; the first is the one its message was recorded in. */
    operationIds: z.array(OperationId).max(20),
    /** The importer's `Message IN` (the button tap or the keyword). */
    messageId: MessageId,
    wamid: z.string().min(1).max(256),
    /** Simulated instant of the inbound message. */
    atSim: ZonedInstant,
    via: z.enum(["BUTTON", "KEYWORD"]),
  })
  .strict();

/** The console's `registry.consent.revoke` input, plus the importer's message when the channel calls. */
export const RevokeConsentInput = ConsentRevokeInput.extend({ channel: ChannelOrigin.optional() }).strict();

type RevokeInput = z.output<typeof RevokeConsentInput>;
type ChannelOrigin = z.output<typeof ChannelOrigin>;

/** The fixed confirmation and the `OPTED_OUT` escalations of an opt-out by WhatsApp. */
async function followChannelOptOut(ctx: DirectContext<RevokeInput>, deps: ServiceDeps, importer: Importer, origin: ChannelOrigin): Promise<{ readonly confirmed: boolean; readonly escalated: number }> {
  const [target] = origin.operationIds;
  if (target !== undefined) {
    await deps.events.enqueue(
      optOutConfirmationSend({ operationId: target, clockId: importer.clockId, firmId: importer.firmId, eventAtSim: origin.atSim, correlationId: ctx.correlationId, wamid: origin.wamid, answers: origin.messageId }),
    );
  }
  for (const operationId of origin.operationIds) {
    await deps.events.enqueue(
      channelEvent({
        type: "ESCALATE",
        eventId: derivedEventId("ESCALATE", `${origin.wamid}#${operationId}`),
        operationId,
        clockId: importer.clockId,
        firmId: importer.firmId,
        eventAtSim: origin.atSim,
        correlationId: ctx.correlationId,
        reason: "OPTED_OUT",
        ...(operationId === target ? { messageId: origin.messageId } : {}),
      }),
    );
  }
  return { confirmed: target !== undefined, escalated: origin.operationIds.length };
}

export function revokeConsentHandler(deps: ServiceDeps) {
  return createDirectHandler(
    {
      name: "revoke_consent",
      input: RevokeConsentInput,
      callers: ["CHANNEL", "CONSOLE", "QA"],
      async run(ctx) {
        const { input } = ctx;
        const fromChannel = ctx.caller.kind === "CHANNEL";
        if (fromChannel !== (input.channel !== undefined)) throw new ToolError("INVALID", "only the channel brings the importer's message", "CHANNEL_ORIGIN");
        const importer = await importerOf(ctx, input.importerId, input.clockId);
        const atSim = input.channel?.atSim ?? (await ctx.world(importer.clockId)).atSim;
        const current = await ctx.connector.parties.getConsent(importer.importerId);
        if (current === undefined && !fromChannel) throw new ToolError("NOT_FOUND", "the importer has no opt-in to revoke", "NO_CONSENT");
        const inForce = current !== undefined && entryAt(current.history, atSim)?.action === "GRANTED" && current.revokedAt === undefined;
        let consent = current;
        if (inForce) {
          consent = await ctx.connector.parties.revokeConsent({
            importerId: importer.importerId,
            atSim,
            atReal: ctx.now().toISOString(),
            by: fromChannel ? "IMPORTER" : ctx.actor,
            reason: input.reason ?? (input.channel === undefined ? undefined : `whatsapp ${input.channel.via.toLowerCase()}`),
          });
          await ctx.audit({
            firmId: importer.firmId,
            decision: "ACTION",
            action: "CONSENT_REVOKED",
            clockId: importer.clockId,
            atSim,
            ...(input.channel === undefined ? {} : { operationId: input.channel.operationIds[0], messageId: input.channel.messageId, trigger: "IMPORTER_MESSAGE" }),
            refs: { importerId: importer.importerId },
            detail: { via: input.channel?.via ?? "CONSOLE" },
          });
        }
        const followed = input.channel === undefined ? { confirmed: false, escalated: 0 } : await followChannelOptOut(ctx, deps, importer, input.channel);
        return {
          importerId: importer.importerId,
          revoked: inForce,
          ...(consent === undefined ? { consent: { status: "NONE" as const } } : { consent: consentView(consent) }),
          ...followed,
        };
      },
    },
    deps,
  );
}
