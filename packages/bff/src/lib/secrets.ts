/// <reference path="../../sst-env.d.ts" />
// Linked `sst.Secret` values (infra/secrets.ts, docs/architecture.md §3), read through `Resource`
// (never `process.env`) and validated with zod. The master `SessionTokenKey` never leaves this
// module: callers ask for the subkey of their purpose (lib/crypto.ts derives it with HKDF).
import { Resource } from "sst";
import { z } from "zod";
import { FirmId, ImporterId, ToolError } from "@legajo/shared";
import { type SubkeyPurpose, deriveSubkey } from "./crypto";

export const SECRET_NAMES = ["SessionTokenKey", "WabaId", "WhatsAppPhoneNumberId", "SeedOverrides"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const SecretResource = z.object({ value: z.string().min(1) });
const cache = new Map<SecretName, string>();
const subkeys = new Map<SubkeyPurpose, Uint8Array>();
let overrides: SeedOverrides | undefined;

export function secretValue(name: SecretName): string {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  let raw: unknown;
  try {
    // `Resource` is a Proxy that throws for anything not linked to this function.
    raw = Reflect.get(Resource, name);
  } catch (error) {
    throw new ToolError("UNAVAILABLE", `secret "${name}" is not linked to this function`, undefined, { cause: error });
  }
  const parsed = SecretResource.safeParse(raw);
  if (!parsed.success) throw new ToolError("UNAVAILABLE", `secret "${name}" has no value in this stage`);
  cache.set(name, parsed.data.value);
  return parsed.data.value;
}

// The master key is 32 random bytes in base64 (44 characters); anything shorter weakens every
// subkey derived from it, so fail loudly instead of signing.
const MIN_KEY_LENGTH = 32;

function sessionTokenKey(): string {
  const key = secretValue("SessionTokenKey");
  if (key.length < MIN_KEY_LENGTH) throw new ToolError("UNAVAILABLE", `SessionTokenKey must have at least ${MIN_KEY_LENGTH} characters`);
  return key;
}

/** The HKDF subkey of one purpose (`session`, `phone-hash`, `thread`, …), derived once per container. */
export function subkey(purpose: SubkeyPurpose): Uint8Array {
  const cached = subkeys.get(purpose);
  if (cached !== undefined) return cached;
  const derived = deriveSubkey(sessionTokenKey(), purpose);
  subkeys.set(purpose, derived);
  return derived;
}

/** Value of `WabaId` and `WhatsAppPhoneNumberId` until docs/pending.md P-01 is closed. */
export const NOT_CONNECTED = "not-connected";

export interface WhatsAppConnection {
  readonly wabaId: string;
  readonly phoneNumberId: string;
}

/** The WABA identity of live WhatsApp, or `undefined` while either secret still says `not-connected`. */
export function whatsAppConnection(): WhatsAppConnection | undefined {
  const wabaId = secretValue("WabaId");
  const phoneNumberId = secretValue("WhatsAppPhoneNumberId");
  if (wabaId === NOT_CONNECTED || phoneNumberId === NOT_CONNECTED) return undefined;
  return { wabaId, phoneNumberId };
}

const Email = z.email().transform((value) => value.toLowerCase());
const E164 = z.string().regex(/^\+[1-9][0-9]{7,14}$/, "expected an E.164 phone number");

/**
 * `SeedOverrides` (docs/seed-spec.md §1): registered demo recipients of the team. It holds real
 * addresses, so it is PII: never logged, and only the recipient fence and the loader read it.
 */
export const SeedOverrides = z
  .object({
    demoRecipients: z.object({ emails: z.array(Email).default([]), phones: z.array(E164).default([]) }).strict().default({ emails: [], phones: [] }),
    firmMailboxCc: z.record(FirmId, z.array(Email)).default({}),
    importerPhones: z.record(ImporterId, E164).default({}),
    operatorEmail: Email.optional(),
  })
  .strict();
export type SeedOverrides = z.infer<typeof SeedOverrides>;

/** Parses the JSON of `SeedOverrides`; an invalid value fails without echoing it. */
export function parseSeedOverrides(json: string): SeedOverrides {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ToolError("UNAVAILABLE", "secret \"SeedOverrides\" is not valid JSON");
  }
  const parsed = SeedOverrides.safeParse(raw);
  if (!parsed.success) {
    const paths = parsed.error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");
    throw new ToolError("UNAVAILABLE", `secret "SeedOverrides" has an invalid shape at ${paths}`);
  }
  return parsed.data;
}

export function seedOverrides(): SeedOverrides {
  overrides ??= parseSeedOverrides(secretValue("SeedOverrides"));
  return overrides;
}

/** Test seam. */
export function resetSecretCache(): void {
  cache.clear();
  subkeys.clear();
  overrides = undefined;
}
