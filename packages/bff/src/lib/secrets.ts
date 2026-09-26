/// <reference path="../../sst-env.d.ts" />
// Linked `sst.Secret` values (infra/secrets.ts), read through `Resource` (never `process.env`). Kept
// apart from lib/crypto.ts so the primitives stay pure and testable without an SST link.
import { Resource } from "sst";
import { z } from "zod";
import { ToolError } from "@legajo/shared";

export const SECRET_NAMES = ["SessionTokenKey", "WabaId", "WhatsAppPhoneNumberId", "SeedOverrides"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

const SecretResource = z.object({ value: z.string().min(1) });
const cache = new Map<SecretName, string>();

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

export function sessionTokenKey(): string {
  const key = secretValue("SessionTokenKey");
  if (key.length < MIN_KEY_LENGTH) throw new ToolError("UNAVAILABLE", `SessionTokenKey must have at least ${MIN_KEY_LENGTH} characters`);
  return key;
}

/** Test seam. */
export function resetSecretCache(): void {
  cache.clear();
}
