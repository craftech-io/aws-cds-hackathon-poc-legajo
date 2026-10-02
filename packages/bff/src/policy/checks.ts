// The builders of a rule's result, and `missing`: the one place that decides what a rule does
// without a fact it needs. A send decided now fails closed (`DENY`); a past send re-checked skips what
// cannot be rebuilt (`SKIP`), because its `ALLOW` decision already recorded what was checked when it
// went out.
import { TO_FIRM, TO_IMPORTER, TO_SUPPLIER, type Route } from "./kinds";
import type { EvaluationMode, RuleCheck } from "./types";

/** Rule details are stored in `AuditLog` (≤ 300 characters) and never carry an address or a value. */
const MAX_DETAIL = 300;

function clip(detail: string): string {
  return detail.length <= MAX_DETAIL ? detail : `${detail.slice(0, MAX_DETAIL - 1)}…`;
}

export function pass(detail: string): RuleCheck {
  return { result: "PASS", detail: clip(detail) };
}

export function deny(detail: string): RuleCheck {
  return { result: "DENY", detail: clip(detail) };
}

export function skip(detail: string): RuleCheck {
  return { result: "SKIP", detail: clip(detail) };
}

export function defer(detail: string, next: Date, zone: string): RuleCheck {
  return { result: "DEFER", detail: clip(detail), next, zone };
}

/** A fact the rule needs is absent: fail closed when deciding a send, skip when checking the past. */
export function missing(ctx: { readonly mode: EvaluationMode }, fact: string): RuleCheck {
  return ctx.mode === "SEND" ? deny(`${fact} is missing: the policy fails closed`) : skip(`${fact} is not rebuilt for a past instant`);
}

/** "the importer by WhatsApp", "the firm by EMAIL": how a detail names the recipient. */
export function recipientText(route: Route): string {
  if (route === TO_IMPORTER) return "the importer by WhatsApp";
  if (route === TO_SUPPLIER) return "the supplier by email";
  if (route === TO_FIRM) return "the firm's mailbox by email";
  const [counterpart = "", channel = ""] = route.split(":");
  return `the ${counterpart.toLowerCase()} by ${channel.toLowerCase()}`;
}
