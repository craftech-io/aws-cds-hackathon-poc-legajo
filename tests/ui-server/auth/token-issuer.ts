// Tokens of the local UI server's user pool (docs/test-plan.md §2, level UI): id tokens signed RS256
// with a key pair made for this server process only, never written anywhere, and the opaque access
// and refresh tokens the console keeps. The BFF's real verifier checks the id tokens against the JWKS
// that tests/ui-server/main.ts hands in (this key plus the Playwright run's key, which signs the
// sessions the specs plant). Nothing here ships in a Lambda.
import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";

export const UI_SERVER_KEY_ID = "legajo-ui-server-ephemeral";

/** 15 minutes, like the pool (docs/architecture.md §10). */
export const ID_TOKEN_SECONDS = 900;

export interface Jwk {
  readonly kty: string;
  readonly n: string;
  readonly e: string;
  readonly kid: string;
  readonly alg: "RS256";
  readonly use: "sig";
}

export interface TokenIssuer {
  readonly jwks: { readonly keys: readonly Jwk[] };
  readonly issuer: string;
  idToken(claims: Readonly<Record<string, unknown>>, nowSeconds: number): string;
  opaque(kind: "access" | "refresh"): string;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sign(privateKey: KeyObject, payload: Readonly<Record<string, unknown>>): string {
  const header = base64Url(JSON.stringify({ alg: "RS256", kid: UI_SERVER_KEY_ID, typ: "JWT" }));
  const body = base64Url(JSON.stringify(payload));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${base64Url(signer.sign(privateKey))}`;
}

export function createTokenIssuer(pool: { readonly userPoolId: string; readonly clientId: string }): TokenIssuer {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const region = pool.userPoolId.split("_")[0] ?? "us-east-1";
  const issuer = `https://cognito-idp.${region}.amazonaws.com/${pool.userPoolId}`;
  return {
    jwks: { keys: [{ kty: "RSA", n: exported.n ?? "", e: exported.e ?? "", kid: UI_SERVER_KEY_ID, alg: "RS256", use: "sig" }] },
    issuer,
    idToken(claims, nowSeconds) {
      return sign(privateKey, { iss: issuer, aud: pool.clientId, token_use: "id", iat: nowSeconds, exp: nowSeconds + ID_TOKEN_SECONDS, ...claims });
    },
    opaque(kind) {
      return `ui-${kind}-${randomUUID()}`;
    },
  };
}
