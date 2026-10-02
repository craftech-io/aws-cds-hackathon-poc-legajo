// The contact-policy engine (docs/design-brief.md §5.7, ADR-0012): the `CP-*` rules in the order of
// `CONTACT_POLICY_RULES` (packages/shared/src/rules.ts). The first rule that denies ends the
// evaluation and is the decision; a time rule that denies defers the send instead, with
// `nextAllowedAt`: the first instant at which every time rule (both business hours and the daily cap)
// allows it, so the deferred send is not deferred again by the rule after it. An allowed send lists
// every rule that passed. Pure: the instant comes in `clock`, and nothing reads the machine's clock.
//
// Two evaluations share the rules:
//   evaluate      a send decided now (the send tools, the milestone fallback, the firm's messages,
//                 `deferred_send`, `fence.probe`); a fact it needs and does not get fails closed
//   evaluateAsOf  a send that already went out, decided at its own instant from the dated histories
//                 (as-of.ts: `PolicyAudit` and the seed invariants)
import { CONTACT_POLICY_RULES, type ContactPolicyRuleId } from "@legajo/shared";
import { toZonedIso } from "../services/business-hours";
import { type PolicyContext, buildContext } from "./context";
import { checkOnePerDay } from "./frequency";
import { checkHoursAr, checkHoursSupplier } from "./hours";
import { policyErrorCode } from "./result";
import {
  checkApprovedScope,
  checkBouncedContact,
  checkControl,
  checkFence,
  checkForeignLinks,
  checkKindChannel,
  checkOptIn,
  checkOptOut,
  checkSensitiveAsk,
  checkSupplierAuth,
} from "./rules";
import { type EvaluationMode, type PolicyDecision, type PolicyInput, PolicyInput as PolicyInputSchema, type RuleCheck, type RuleEvaluation } from "./types";
import { checkWindow, windowAt } from "./window";

type TimeRule = (ctx: PolicyContext, at: Date) => RuleCheck;

interface RuleEntry {
  readonly check: (ctx: PolicyContext) => RuleCheck;
  /** Time rules: the same check at another instant (the search for `nextAllowedAt`). */
  readonly at?: TimeRule;
}

function timed(rule: TimeRule): RuleEntry {
  return { check: (ctx) => rule(ctx, ctx.simNow), at: rule };
}

const RULES: Readonly<Record<ContactPolicyRuleId, RuleEntry>> = {
  "CP-CONTROL-BROKER": { check: checkControl },
  "CP-KIND-CHANNEL": { check: checkKindChannel },
  "CP-RECIPIENT-FENCE": { check: checkFence },
  "CP-OPTIN": { check: checkOptIn },
  "CP-OPTOUT": { check: checkOptOut },
  "CP-SUPPLIER-AUTH": { check: checkSupplierAuth },
  "CP-BOUNCED-CONTACT": { check: checkBouncedContact },
  "CP-APPROVED-SCOPE": { check: checkApprovedScope },
  "CP-HOURS-AR": timed(checkHoursAr),
  "CP-HOURS-SUPPLIER": timed(checkHoursSupplier),
  "CP-ONE-PER-DAY": timed(checkOnePerDay),
  "CP-WA-24H": { check: checkWindow },
  "CP-NO-SENSITIVE-ASK": { check: checkSensitiveAsk },
  "CP-NO-FOREIGN-LINKS": { check: checkForeignLinks },
};

const TIME_RULES: readonly TimeRule[] = CONTACT_POLICY_RULES.flatMap((ruleId) => {
  const rule = RULES[ruleId].at;
  return rule === undefined ? [] : [rule];
});

/** A year of weekends, holidays and daily caps; past it the inputs are broken, not busy. */
const MAX_SEARCH_ROUNDS = 400;

/** From the first deferral, the first instant at which no time rule defers any more. */
function firstAllowedInstant(ctx: PolicyContext, from: Date): Date {
  let at = from;
  for (let round = 0; round < MAX_SEARCH_ROUNDS; round += 1) {
    let moved = false;
    for (const rule of TIME_RULES) {
      const { result, next } = rule(ctx, at);
      if (result === "DEFER" && next !== undefined && next.getTime() > at.getTime()) {
        at = next;
        moved = true;
      }
    }
    if (!moved) return at;
  }
  throw new RangeError(`no instant within ${MAX_SEARCH_ROUNDS} rounds satisfies the time rules`);
}

export interface EvaluateOptions {
  /** Guest every rule instead of stopping at the first denial (`PolicyAudit` reports every breach). */
  readonly exhaustive?: boolean;
}

interface Breach {
  readonly ruleId: ContactPolicyRuleId;
  readonly check: RuleCheck;
}

function decide(ctx: PolicyContext, evaluated: readonly RuleEvaluation[], breaches: readonly Breach[]): PolicyDecision {
  const window = ctx.toImporterByWhatsApp && ctx.history !== undefined ? { window: windowAt(ctx) } : {};
  const reply = ctx.reply === true;
  const [first] = breaches;
  if (first === undefined) {
    const ruleIds = evaluated.filter((entry) => entry.result === "PASS").map((entry) => entry.ruleId);
    return { outcome: "ALLOW", allowed: true, deferred: false, ruleIds, evaluated, reply, ...window };
  }
  const ruleIds = breaches.map((breach) => breach.ruleId);
  const base = { allowed: false, ruleIds, reason: first.check.detail, errorCode: policyErrorCode(first.ruleId, first.check.result), evaluated, reply, ...window };
  const { next, zone } = first.check;
  if (first.check.result !== "DEFER" || next === undefined || zone === undefined) return { ...base, outcome: "DENY", deferred: false };
  return { ...base, outcome: "DEFER", deferred: true, nextAllowedAt: toZonedIso(firstAllowedInstant(ctx, next), zone) };
}

function run(ctx: PolicyContext, options: EvaluateOptions): PolicyDecision {
  const evaluated: RuleEvaluation[] = [];
  const breaches: Breach[] = [];
  for (const ruleId of CONTACT_POLICY_RULES) {
    const check = RULES[ruleId].check(ctx);
    evaluated.push({ ruleId, result: check.result, detail: check.detail });
    if (check.result !== "DENY" && check.result !== "DEFER") continue;
    breaches.push({ ruleId, check });
    if (options.exhaustive !== true) break;
  }
  return decide(ctx, evaluated, breaches);
}

/** Evaluation under a mode; `evaluate` and `evaluateAsOf` are the two entries. */
export function evaluateIn(mode: EvaluationMode, input: PolicyInput, options: EvaluateOptions = {}): PolicyDecision {
  return run(buildContext(PolicyInputSchema.parse(input), mode), options);
}

/** A send decided now: `clock` is the world's "now"; a missing fact fails closed. */
export function evaluate(input: PolicyInput, options: EvaluateOptions = {}): PolicyDecision {
  return evaluateIn("SEND", input, options);
}
