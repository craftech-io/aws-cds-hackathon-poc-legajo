// Email domains of the stage and the operation's thread address (docs/architecture.md §1,
// docs/architecture-integrations.md §1). The recipient fence, the seed generator and validator, the
// world factory, `InboundEmail` and `SimMail` all build or check these, so they live here once.
import { z } from "zod";
import { ClockId } from "./clock-ids";
import { hmacSha256 } from "./hash";
import { OperationNumber } from "./ids";

/** Console, landing and the operation thread addresses (`op-<n>-<tag>@…`, `avisos@…`). */
export const STAGE_DOMAIN = "legajo.demo.craftech.io";
/** Simulated mailboxes: suppliers, firms, QA parties and the QA injector. */
export const SIM_MAIL_DOMAIN = `sim.${STAGE_DOMAIN}`;
/** SES mailbox simulator: the only way bounces and complaints are produced. */
export const SES_MAILBOX_SIMULATOR_DOMAIN = "simulator.amazonses.com";
/** Sender of escalations to the firm's mailbox. */
export const NOTICES_ADDRESS = `avisos@${STAGE_DOMAIN}`;

/** Local part prefix of the `QaDriver` injector mailbox, which is never a party (seed invariant 20). */
export const QA_INJECTOR_PREFIX = "qainject-";
/** Local part prefix reserved to the mailboxes of parties cloned into QA worlds. */
export const QA_PARTY_PREFIX = "qa-";

// RFC 2606 and RFC 6761: never a recipient, never in the seed.
const RESERVED_TLDS: readonly string[] = ["test", "example", "invalid", "localhost"];
const RESERVED_DOMAINS: readonly string[] = ["example.com", "example.net", "example.org"];

/** True for a reserved domain or any subdomain of one; compares lower-cased, ignoring a trailing dot. */
export function isReservedDomain(domain: string): boolean {
  const name = domain.trim().toLowerCase().replace(/\.$/, "");
  const tld = name.slice(name.lastIndexOf(".") + 1);
  return RESERVED_TLDS.includes(tld) || RESERVED_DOMAINS.some((reserved) => name === reserved || name.endsWith(`.${reserved}`));
}

// --- Thread address ------------------------------------------------------------------------

/**
 * Tag of a thread address: the first 6 characters of HMAC(K_thread, number ‖ clockId ‖ worldEpoch)
 * in lower-case Crockford base32 (no i, l, o, u), so it cannot be enumerated, tells worlds with the
 * same number apart and stops resolving after a reset raises the epoch.
 */
export const THREAD_TAG_LENGTH = 6;
export const ThreadTag = z.string().regex(/^[0-9a-hjkmnp-tv-z]{6}$/, "expected a 6-character thread tag");
export type ThreadTag = z.infer<typeof ThreadTag>;

const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const THREAD_ADDRESS = new RegExp(`^op-(\\d{4})-([0-9a-hjkmnp-tv-z]{6})@${STAGE_DOMAIN.replaceAll(".", "\\.")}$`);

export interface ThreadTagInput {
  readonly operationNumber: string;
  readonly clockId: string;
  readonly worldEpoch: number;
}

/** The HMAC message; `|` cannot appear in a number, a clock id or an epoch, so fields never run together. */
export function threadTagMessage(input: ThreadTagInput): string {
  if (!Number.isInteger(input.worldEpoch) || input.worldEpoch < 1) throw new RangeError(`invalid world epoch ${input.worldEpoch}`);
  return `${OperationNumber.parse(input.operationNumber)}|${ClockId.parse(input.clockId)}|${input.worldEpoch}`;
}

function crockfordBase32(bytes: Uint8Array, length: number): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = ((buffer << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD_ALPHABET[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
      if (out.length === length) return out;
    }
  }
  throw new RangeError(`need more bytes for ${length} base32 characters`);
}

/**
 * `key` is the `thread` subkey derived from `SessionTokenKey` in the stage, or the fixed test key of
 * the seed generator (`SEED_TEST_THREAD_KEY`, docs/seed-spec.md §15 invariant 2).
 */
export async function computeThreadTag(key: string | Uint8Array, input: ThreadTagInput): Promise<ThreadTag> {
  return crockfordBase32(await hmacSha256(key, threadTagMessage(input)), THREAD_TAG_LENGTH);
}

/** Compares the whole tag without an early exit, so a guess learns nothing from the timing. */
export async function verifyThreadTag(key: string | Uint8Array, input: ThreadTagInput, tag: string): Promise<boolean> {
  const expected = await computeThreadTag(key, input);
  let difference = expected.length ^ tag.length;
  for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ (tag.charCodeAt(index) || 0);
  return difference === 0;
}

/** `op-4471-k7p2q9@legajo.demo.craftech.io`. */
export function threadAddress(operationNumber: string, threadTag: string): string {
  return `op-${OperationNumber.parse(operationNumber)}-${ThreadTag.parse(threadTag)}@${STAGE_DOMAIN}`;
}

/** Exact match only: lower case, the stage domain and nothing around it (no display name, no trailing dot). */
export function parseThreadAddress(address: string): { operationNumber: OperationNumber; threadTag: ThreadTag } | undefined {
  const match = THREAD_ADDRESS.exec(address);
  if (!match) return undefined;
  return { operationNumber: match[1] ?? "", threadTag: match[2] ?? "" };
}
