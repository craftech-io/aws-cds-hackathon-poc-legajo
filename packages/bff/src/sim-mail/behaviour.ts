// The supplier simulator's rules (docs/architecture-integrations.md §3), deterministic and without a
// model: how a supplier with a behaviour reacts to one of our requests, what each reply carries, and
// the loop guard. Pure functions over the operation's `simState`; supplier-simulator.ts does the I/O.
//
//   PROMPT              the final version (no observations) of what was asked, 10 simulated minutes later
//   SEEDED_ERROR        v1 with the seeded inconsistency; after a CORRECTION_REQUEST, the final version
//   SEEDED_ERROR_TWICE  v1; after a correction, the next version (v2 keeps the same observation in the
//                       seed); after the second correction, the final one
//   LATE                as PROMPT, `behaviourParams.delayHours` later
//   PROMISE             "We will send it tomorrow" now, no attachments; PROMPT `promiseHours` (24) later
//   NEVER               no reply
//   AUTO_REPLY          an out-of-office with `Auto-Submitted: auto-replied` now; PROMPT
//                       `realReplyAfterHours` (2) later
//   WRONG_DOC           the first reply attaches another document of the dossier in place of the one
//                       asked; any later request gets the right one
//   UNKNOWN_DOC         a PDF the reader does not know (`Seed/pdfs/unknown/`)
//   INJECTION           the two hostile bodies in successive replies, each with the correct PDFs
//                       (their `Title` carries another instruction in the seed)
//   BOUNCE, COMPLAINT   the contact is SES's mailbox simulator: SimMail never receives anything
//
// "Final version" is the highest version the seed has for that document of the model operation.
import { DocType, type MessageKind, type SupplierBehaviour } from "@legajo/shared";
import type { SimState } from "../domain/operations";
import type { BehaviourParams } from "../domain/parties";
import { NO_REPLY_REASONS, type NoReplyReason, SIM_DAY_OFFSET_MS, SIM_DELAYS, SIM_REPLY_DAILY_CAP } from "./config";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** What we asked for, from `X-Legajo-Request` of the verified outbound mail. */
export interface SimRequest {
  readonly kind: MessageKind;
  readonly docTypes: readonly DocType[];
}

/** First reply to a request, or the documents that follow a promise or an out-of-office. */
export type ReplyPhase = "REPLY" | "FOLLOW_UP";

export type Reaction =
  | { readonly kind: "NO_REPLY"; readonly reason: NoReplyReason }
  /** A `TIMER#SIM_REPLY#` this long after the mail arrived (simulated time). */
  | { readonly kind: "SCHEDULE"; readonly afterMs: number }
  /** A text now, and a `TIMER#SIM_REPLY#` with the documents `followUpAfterMs` later. */
  | { readonly kind: "IMMEDIATE"; readonly body: "PROMISE" | "AUTO_REPLY"; readonly followUpAfterMs: number };

/** How a supplier with this behaviour reacts to a request it received. */
export function reactionTo(behaviour: SupplierBehaviour, params: BehaviourParams, request: SimRequest): Reaction {
  if (behaviour === "NEVER") return { kind: "NO_REPLY", reason: NO_REPLY_REASONS.never };
  if (behaviour === "BOUNCE" || behaviour === "COMPLAINT") return { kind: "NO_REPLY", reason: NO_REPLY_REASONS.sesSimulator };
  if (request.docTypes.length === 0) return { kind: "NO_REPLY", reason: NO_REPLY_REASONS.nothingRequested };
  if (behaviour === "PROMISE") return { kind: "IMMEDIATE", body: "PROMISE", followUpAfterMs: (params.promiseHours ?? SIM_DELAYS.promiseHours) * HOUR_MS };
  if (behaviour === "AUTO_REPLY") return { kind: "IMMEDIATE", body: "AUTO_REPLY", followUpAfterMs: (params.realReplyAfterHours ?? SIM_DELAYS.autoReplyHours) * HOUR_MS };
  if (behaviour === "LATE") return { kind: "SCHEDULE", afterMs: (params.delayHours ?? SIM_DELAYS.lateHours) * HOUR_MS };
  return { kind: "SCHEDULE", afterMs: SIM_DELAYS.replyMinutes * MINUTE_MS };
}

/** A PDF a reply attaches: a template of the model operation, or one of the unknown ones. */
export type PlannedPdf = { readonly source: "TEMPLATE"; readonly docType: DocType; readonly version: number } | { readonly source: "UNKNOWN"; readonly index: number };

export type ReplyBody =
  | { readonly kind: "DOCUMENTS" }
  | { readonly kind: "CORRECTED" }
  | { readonly kind: "INJECTION"; readonly index: 0 | 1 }
  | { readonly kind: "PROMISE" }
  | { readonly kind: "AUTO_REPLY" };

export interface ReplyPlan {
  readonly body: ReplyBody;
  readonly pdfs: readonly PlannedPdf[];
  /** The documents the text says it attaches (what was asked). */
  readonly claimed: readonly DocType[];
  /** `Auto-Submitted: auto-replied`. */
  readonly autoReply: boolean;
  /** Versions this reply sends, per document type (merged into `simState.versionsSent`). */
  readonly versions: Readonly<Partial<Record<DocType, number>>>;
  readonly injectionStep: number;
}

export interface PlanInput {
  readonly behaviour: SupplierBehaviour;
  readonly phase: ReplyPhase;
  readonly request: SimRequest;
  readonly state: SimState;
  /** Highest version of each document of the model operation in the seed. */
  readonly latest: Readonly<Record<DocType, number>>;
  readonly unknownCount: number;
}

/** Documents in dossier order, without repeats. */
function inOrder(docTypes: readonly DocType[]): DocType[] {
  return DocType.options.filter((docType) => docTypes.includes(docType));
}

function versionFor(input: PlanInput, docType: DocType): number {
  const final = input.latest[docType];
  const sent = input.state.versionsSent[docType];
  const correction = input.request.kind === "CORRECTION_REQUEST";
  if (input.phase === "REPLY" && input.behaviour === "SEEDED_ERROR") return correction ? final : (sent ?? 1);
  if (input.phase === "REPLY" && input.behaviour === "SEEDED_ERROR_TWICE") return correction ? Math.min((sent ?? 1) + 1, final) : (sent ?? 1);
  return final;
}

function templates(input: PlanInput, docTypes: readonly DocType[]): PlannedPdf[] {
  return docTypes.map((docType): PlannedPdf => ({ source: "TEMPLATE", docType, version: versionFor(input, docType) }));
}

function versionsOf(pdfs: readonly PlannedPdf[]): Partial<Record<DocType, number>> {
  const versions: Partial<Record<DocType, number>> = {};
  for (const pdf of pdfs) if (pdf.source === "TEMPLATE") versions[pdf.docType] = pdf.version;
  return versions;
}

/** The text that answers now (`PROMISE`, `AUTO_REPLY`), without attachments. */
export function planImmediate(body: "PROMISE" | "AUTO_REPLY", input: Pick<PlanInput, "request" | "state">): ReplyPlan {
  return { body: { kind: body }, pdfs: [], claimed: inOrder(input.request.docTypes), autoReply: body === "AUTO_REPLY", versions: {}, injectionStep: input.state.injectionStep };
}

/** What a reply that carries documents attaches and says. */
export function planReply(input: PlanInput): ReplyPlan {
  const requested = inOrder(input.request.docTypes);
  const body: ReplyBody = input.request.kind === "CORRECTION_REQUEST" ? { kind: "CORRECTED" } : { kind: "DOCUMENTS" };
  const plan = (pdfs: PlannedPdf[], replyBody: ReplyBody = body, injectionStep = input.state.injectionStep): ReplyPlan => ({
    body: replyBody,
    pdfs,
    claimed: requested,
    autoReply: false,
    versions: versionsOf(pdfs),
    injectionStep,
  });
  if (input.phase === "FOLLOW_UP") return plan(templates(input, requested));
  switch (input.behaviour) {
    case "WRONG_DOC": {
      if (input.state.repliesSent > 0) return plan(templates(input, requested));
      const substitute = DocType.options.find((docType) => !requested.includes(docType)) ?? "COMMERCIAL_INVOICE";
      return plan(templates(input, [substitute]));
    }
    case "UNKNOWN_DOC":
      return plan([{ source: "UNKNOWN", index: (input.state.repliesSent % Math.max(1, input.unknownCount)) + 1 }]);
    case "INJECTION":
      return plan(templates(input, requested), { kind: "INJECTION", index: input.state.injectionStep % 2 === 0 ? 0 : 1 }, input.state.injectionStep + 1);
    default:
      return plan(templates(input, requested));
  }
}

// ---- The loop guard: at most 6 replies per operation and simulated day, and per real day ----------

/** The broker's calendar day (UTC−3) of a simulated instant. */
export function simDayOf(instant: string): string {
  return new Date(Date.parse(instant) + SIM_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

export function realDayOf(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function dailyCapReached(state: SimState, simNow: string, realNow: Date): boolean {
  const simDay = state.repliesOnSimDay?.day === simDayOf(simNow) ? state.repliesOnSimDay.count : 0;
  const realDay = state.repliesOnRealDay?.day === realDayOf(realNow) ? state.repliesOnRealDay.count : 0;
  return simDay >= SIM_REPLY_DAILY_CAP || realDay >= SIM_REPLY_DAILY_CAP;
}

/** `simState` after one more reply. */
export function afterReply(state: SimState, plan: ReplyPlan, simNow: string, realNow: Date): SimState {
  const simDay = simDayOf(simNow);
  const realDay = realDayOf(realNow);
  return {
    ...state,
    repliesSent: state.repliesSent + 1,
    versionsSent: { ...state.versionsSent, ...plan.versions },
    lastReplyAtSim: simNow,
    repliesOnSimDay: { day: simDay, count: (state.repliesOnSimDay?.day === simDay ? state.repliesOnSimDay.count : 0) + 1 },
    repliesOnRealDay: { day: realDay, count: (state.repliesOnRealDay?.day === realDay ? state.repliesOnRealDay.count : 0) + 1 },
    injectionStep: plan.injectionStep,
  };
}
