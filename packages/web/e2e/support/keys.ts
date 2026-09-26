// Ephemeral RSA key of a Playwright run (docs/test-plan.md §2): it signs the id tokens of every
// session the specs plant or the scripted Cognito hands out, so the real verifier of the BFF accepts
// them in the local UI server. It exists only in memory and in the environment of this run:
// playwright.config.ts creates it once (E2E_SIGNING_KEY, PEM, inherited by the workers) and gives the
// UI server only its public half (E2E_JWKS). Never a key of a real pool, never written to disk.
import { createPrivateKey, createPublicKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";

export const SIGNING_KEY_ENV = "E2E_SIGNING_KEY";
export const JWKS_ENV = "E2E_JWKS";
export const KEY_ID = "legajo-e2e-ephemeral";

/** Creates the run's key unless the runner already did, and publishes its JWKS for the UI server. */
export function ensureEphemeralKey(): void {
  if (!process.env[SIGNING_KEY_ENV]) {
    const generated = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env[SIGNING_KEY_ENV] = generated.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  }
  process.env[JWKS_ENV] = JSON.stringify(publicJwks());
}

let cached: { readonly pem: string; readonly key: KeyObject } | undefined;

function privateKey(): KeyObject {
  if (!process.env[SIGNING_KEY_ENV]) ensureEphemeralKey();
  const pem = process.env[SIGNING_KEY_ENV] ?? "";
  if (cached?.pem !== pem) cached = { pem, key: createPrivateKey(pem) };
  return cached.key;
}

/** Public half of the run's key as a JWKS document (what `cacheJwks` of the verifier takes). */
export function publicJwks(): { readonly keys: readonly Record<string, unknown>[] } {
  const jwk = createPublicKey(privateKey()).export({ format: "jwk" });
  return { keys: [{ ...jwk, kid: KEY_ID, alg: "RS256", use: "sig" }] };
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

/** A compact RS256 JWT signed with the run's key. */
export function signJwt(payload: Readonly<Record<string, unknown>>): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: KEY_ID, typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${base64Url(signer.sign(privateKey()))}`;
}
