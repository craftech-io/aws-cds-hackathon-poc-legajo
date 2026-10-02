// Core enums every edge shares: channels and their modes, roles, tenants, worlds and the error codes
// of the tool envelope. The domain enums live next to this file (enums-dossier.ts,
// enums-messaging.ts, enums-runtime.ts); enums.test.ts snapshots all of them and checks them against
// docs/tool-catalog.md "Tipos compartidos" and CONTEXT.md.
import { z } from "zod";

/** Channels the agent writes on (docs/architecture-integrations.md). */
export const SendChannel = z.enum(["EMAIL", "WHATSAPP"]);
export type SendChannel = z.infer<typeof SendChannel>;

/** Every channel of a conversation; `CONSOLE` never carries an outbound message (CONTEXT.md, "Canal"). */
export const Channel = z.enum(["WHATSAPP", "EMAIL", "CONSOLE"]);
export type Channel = z.infer<typeof Channel>;

/** How a channel runs in the stage (ADR-0002, infra/channel-modes.ts). */
export const ChannelMode = z.enum(["live", "simulated"]);
export type ChannelMode = z.infer<typeof ChannelMode>;

/** Key of a channel in `ChannelModes` (infra/channel-modes.ts). */
export const ChannelName = z.enum(["email", "whatsapp"]);
export type ChannelName = z.infer<typeof ChannelName>;

export function channelNameOf(channel: SendChannel): ChannelName {
  return channel === "EMAIL" ? "email" : "whatsapp";
}

/** `code` of every tool failure (docs/tool-catalog.md, Convenciones). */
export const ErrorCode = z.enum([
  "NOT_FOUND",
  "FORBIDDEN",
  "INVALID",
  "CONFLICT",
  "UNAVAILABLE",
  "POLICY_DENIED",
  "DEFERRED",
  "CONTROL_BROKER",
  "TEMPLATE_REQUIRED",
  "RECIPIENT_NOT_ALLOWED",
  "GROUNDING_FAIL",
  "NOT_COMPLETE",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** Console roles, in precedence order (docs/architecture.md §10). */
export const ConsoleRole = z.enum(["BROKER", "GUEST", "ANALYST"]);
export type ConsoleRole = z.infer<typeof ConsoleRole>;

/** Roles that approve and reopen a dossier (ADR-0010): a guest acts as a broker inside its own firm. */
export const APPROVER_ROLES: readonly ConsoleRole[] = ["BROKER", "GUEST"];

export function canApprove(role: ConsoleRole): boolean {
  return APPROVER_ROLES.includes(role);
}

export const Weekday = z.enum(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]);
export type Weekday = z.infer<typeof Weekday>;

/** Language of a party: the importer writes Spanish, suppliers write English (docs/design-brief.md §10). */
export const Language = z.enum(["es", "en"]);
export type Language = z.infer<typeof Language>;

/** `Firm.kind` (docs/architecture.md §5): the operator's demo, a guest's own firm, or a QA firm. */
export const FirmKind = z.enum(["DEMO", "GUEST", "QA"]);
export type FirmKind = z.infer<typeof FirmKind>;

/** `Firm.guestKind` of a `GUEST` firm: a reserved account's fixed firm or a slot of the public range (ADR-0015). */
export const GuestKind = z.enum(["RESERVED", "PUBLIC"]);
export type GuestKind = z.infer<typeof GuestKind>;

/** `world` attribute of the items of QA and guest worlds, the condition of every QA delete (§14). */
export const World = z.enum(["qa", "guest"]);
export type World = z.infer<typeof World>;

/**
 * Sender profile the caller of the single SES client declares; the client checks the `From`
 * against it and applies that profile's recipient fence (docs/architecture-integrations.md §1).
 * `LEAD_NOTICE` is the internal notice of a new lead (ADR-0015 §6): no clock, exact `@craftech.io`
 * recipients from the `LeadNoticeTo` secret only.
 */
export const SenderProfile = z.enum(["SYSTEM", "SIMULATOR", "QA", "LEAD_NOTICE"]);
export type SenderProfile = z.infer<typeof SenderProfile>;

/** Who closes a pending mail of `Runtime/PENDING#<clockId>` (docs/architecture.md §7). */
export const MailAwaiting = z.enum(["SIMMAIL", "INBOUND", "SES_EVENT"]);
export type MailAwaiting = z.infer<typeof MailAwaiting>;

/** `LegajoMetrics.source`: the user's world or a metrics batch (docs/architecture.md §5). */
export const MetricSource = z.enum(["WORLD", "BATCH"]);
export type MetricSource = z.infer<typeof MetricSource>;

/** `LegajoMetrics.agentMode`: the real Harness or the scripted plan of the local flows. */
export const AgentMode = z.enum(["REAL", "SCRIPTED"]);
export type AgentMode = z.infer<typeof AgentMode>;

/** Item types of the `Reference` table, `REF#<type>#<scope>` (docs/seed-spec.md §12). */
export const ReferenceType = z.enum(["HOLIDAY", "TEMPLATE", "RATECARD", "NAMECHECK", "DISPATCH_GLOSSARY", "OBS_CODE", "EVAL"]);
export type ReferenceType = z.infer<typeof ReferenceType>;
