// Keys and derived ids of the seed files. The stage derives its subkeys from `SessionTokenKey`; the
// generator and `seed:validate` use a fixed test master key instead (docs/seed-spec.md §15, invariant
// 2), derived by the same HKDF of lib/crypto.ts and never a secret: the seed's `threadTag`,
// `phoneHash` and `emailHash` are reproducible by anyone, and `seed:load` rewrites all three with the
// stage's subkeys. Event ids of seeded histories use the derived form of docs/architecture.md §7.
import { createHash } from "node:crypto";
import { deriveSubkey, emailHash, phoneHash } from "@legajo/bff/lib/crypto";
import { computeThreadTag, threadAddress } from "@legajo/shared";

/** Constant of the generator the test subkeys come from (not a secret: it is public by design). */
export const SEED_TEST_MASTER_KEY = "aws-cds-hackathon-poc-legajo/seed-test-master-key/v1";

/** `SEED_TEST_THREAD_KEY`: the `thread` subkey of the test master key. */
export const SEED_TEST_THREAD_KEY = deriveSubkey(SEED_TEST_MASTER_KEY, "thread");
const PHONE_HASH_KEY = deriveSubkey(SEED_TEST_MASTER_KEY, "phone-hash");
const EMAIL_HASH_KEY = deriveSubkey(SEED_TEST_MASTER_KEY, "email-hash");

export function seedPhoneHash(phoneE164: string): string {
  return phoneHash(PHONE_HASH_KEY, phoneE164);
}

export function seedEmailHash(email: string): string {
  return emailHash(EMAIL_HASH_KEY, email);
}

export interface SeedThread {
  readonly threadTag: string;
  readonly threadAddress: string;
}

/** Thread tag and address of an operation of `clockId` at `worldEpoch`, with the seed's test key. */
export async function seedThread(operationNumber: string, clockId: string, worldEpoch: number): Promise<SeedThread> {
  const threadTag = await computeThreadTag(SEED_TEST_THREAD_KEY, { operationNumber, clockId, worldEpoch });
  return { threadTag, threadAddress: threadAddress(operationNumber, threadTag) };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const EVENT_ID_PATTERN = /^evt_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Derived `eventId` (docs/architecture.md §7): `evt_` + each of the first 26 bytes of
 * SHA-256("<type>#<natural key>") modulo 32 in upper-case Crockford base32.
 */
export function derivedEventId(type: string, naturalKey: string): string {
  const digest = createHash("sha256").update(`${type}#${naturalKey}`).digest();
  let out = "evt_";
  for (let index = 0; index < 26; index += 1) out += CROCKFORD[(digest[index] ?? 0) % 32];
  return out;
}

/** Event written by the seed into a history: natural key `seed#<operationId>#<n>` (docs/seed-spec.md §2). */
export function seedHistoryEventId(type: "ETA_CHANGED" | "DISPATCH_STATUS", operationId: string, n: number): string {
  return derivedEventId(type, `seed#${operationId}#${n}`);
}
