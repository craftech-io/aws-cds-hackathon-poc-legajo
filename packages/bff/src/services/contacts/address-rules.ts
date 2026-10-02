// What a world's registry may hold (`upsert_party`, docs/tool-catalog.md; ADR-0015 §4; docs/seed-spec.md
// §2, §14 and invariant 20; docs/architecture-integrations.md §1). Checked before anything is written:
//
//   every world    an address the strict parser of the SES client accepts; never the `QaDriver`'s
//                  injector mailbox (`qainject-…`, never a party); a supplier contact the SES client's
//                  `SYSTEM` fence would write to (`*@sim.legajo…`, `*@simulator.amazonses.com` or a
//                  registered demo recipient; never a reserved domain, never an operation's thread):
//                  `RECIPIENT_NOT_ALLOWED`, `DENY CP-RECIPIENT-FENCE`;
//   `qa-*` worlds  a simulated mailbox starts with the world's own `qa-<runId>-<scenario>-` (the QA
//                  fence writes to `qa-*@sim…`, so a party of another world must never look like one);
//   other worlds   a simulated mailbox never starts with `qa-` (reserved to the parties of QA worlds);
//   guest worlds   only synthetic data: supplier contacts in `*@sim.legajo.demo.craftech.io` and
//                  importer phones in the block of the world's slot (`+54 9 11 5551 <nn>xx`), never a
//                  real address or number (FL-123): `RECIPIENT_NOT_ALLOWED`.
import { NOTICES_ADDRESS, QA_GLOBAL_CLOCK_ID, QA_INJECTOR_PREFIX, QA_PARTY_PREFIX, SIM_MAIL_DOMAIN, ToolError, parseClockId } from "@legajo/shared";
import { parseAddress } from "../../channels/email/address";
import { type FenceDeps, checkFence } from "../../channels/email/fence";
import { resolveThread } from "../../channels/email/thread";
import { slotOfFirm } from "../../worlds/guest-slots";
import type { ServiceDeps } from "../operations-admin/ports";

/** `reason` of a refusal of an address or a phone (the console shows the fence's text for `RECIPIENT_NOT_ALLOWED`). */
export const ADDRESS_REASON = {
  INVALID: "ADDRESS_INVALID",
  INJECTOR: "INJECTOR_ADDRESS",
  QA_PREFIX: "QA_PARTY_PREFIX",
  GUEST_SYNTHETIC_ONLY: "GUEST_SYNTHETIC_ONLY",
} as const;

/** `+54 9 11 5551`: the block of every guest world's fictitious phones (docs/seed-spec.md §2). */
const GUEST_PHONE_BLOCK = "+549115551";

function isGuestWorld(clockId: string): boolean {
  return parseClockId(clockId)?.scope === "GUEST";
}

/** `+54 9 11 5551 <nn>xx` of the world's slot; `firm-guest-test` (no slot) keeps the whole guest block. */
export function guestPhonePattern(clockId: string): RegExp | undefined {
  const parsed = parseClockId(clockId);
  if (parsed?.scope !== "GUEST" || parsed.firmId === undefined) return undefined;
  const slot = slotOfFirm(parsed.firmId);
  const nn = slot === undefined ? "\\d{2}" : String(slot).padStart(2, "0");
  return new RegExp(`^\\${GUEST_PHONE_BLOCK}${nn}\\d{2}$`);
}

/** A guest world takes only the phones of its slot's block. */
export function checkPartyPhone(phone: string, clockId: string): void {
  const pattern = guestPhonePattern(clockId);
  if (pattern !== undefined && !pattern.test(phone)) {
    throw new ToolError("RECIPIENT_NOT_ALLOWED", "a guest world only registers the fictitious phones of its own block", ADDRESS_REASON.GUEST_SYNTHETIC_ONLY);
  }
}

function simPrefixProblem(local: string, clockId: string): string | undefined {
  const scope = parseClockId(clockId)?.scope;
  if (scope === "QA") return local.startsWith(`${clockId}-`) ? undefined : "a party of a QA world uses the world's own qa-<runId>-<scenario>- mailboxes";
  if (clockId === QA_GLOBAL_CLOCK_ID) return local.startsWith(QA_PARTY_PREFIX) ? undefined : "a party of the QA world uses qa- mailboxes";
  return local.startsWith(QA_PARTY_PREFIX) ? "qa- mailboxes are reserved to the parties of QA worlds" : undefined;
}

export interface CheckedAddress {
  readonly address: string;
}

/**
 * The shape and the world rules of a supplier contact's address; the fence is `fenceContact`.
 * Throws `INVALID` or `RECIPIENT_NOT_ALLOWED`.
 */
export function checkPartyEmail(raw: string, clockId: string): CheckedAddress {
  const parsed = parseAddress(raw);
  if (!parsed.ok) throw new ToolError("INVALID", `the address is not one the mail client accepts (${parsed.problem.toLowerCase()})`, ADDRESS_REASON.INVALID);
  const { local, domain, address } = parsed.value;
  if (local.startsWith(QA_INJECTOR_PREFIX)) throw new ToolError("INVALID", "the injector mailbox is never a party", ADDRESS_REASON.INJECTOR);
  if (domain === SIM_MAIL_DOMAIN) {
    const problem = simPrefixProblem(local, clockId);
    if (problem !== undefined) throw new ToolError("INVALID", problem, ADDRESS_REASON.QA_PREFIX);
  } else if (isGuestWorld(clockId)) {
    throw new ToolError("RECIPIENT_NOT_ALLOWED", "a guest world only registers simulated mailboxes", ADDRESS_REASON.GUEST_SYNTHETIC_ONLY);
  }
  return { address };
}

export function fenceDepsOf(deps: ServiceDeps): FenceDeps {
  const { operations, world, parties } = deps.connector;
  return {
    resolveThread: (address) => resolveThread({ operations, world, threadKey: deps.keys.threadKey(), now: deps.wallClock }, address),
    parties,
    emailHash: (address) => deps.keys.emailHash(address),
    demoRecipients: deps.demoRecipients,
  };
}

/** `CP-RECIPIENT-FENCE` for a contact: what the `SYSTEM` profile of the SES client would write to from this world. */
export async function fenceContact(deps: ServiceDeps, address: string, clockId: string): Promise<{ readonly allowed: true } | { readonly allowed: false; readonly reason: string }> {
  const decision = await checkFence(fenceDepsOf(deps), { profile: "SYSTEM", from: NOTICES_ADDRESS, to: address, clockId });
  return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
}
