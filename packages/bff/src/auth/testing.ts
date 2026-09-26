// Test-only Cognito stand-in and console wiring: a throwaway RSA key pair, the JWKS a pool would
// publish for it, a signer for id tokens, broker rows in the in-memory connector and the
// `ContextDeps` of a request over them. Nothing here ships in a Lambda bundle (only *.test.ts and
// local test servers import it).
import { type KeyObject, generateKeyPairSync, sign } from "node:crypto";
import type { ChannelMode, ConsoleRole } from "@legajo/shared";
import type { Fetcher } from "aws-jwt-verify/https";
import type { Jwk, Jwks } from "aws-jwt-verify/jwk";
import type { MemoryStores } from "../connector/index";
import { createLogger } from "../lib/log";
import type { HealthCheck } from "../routers/health";
import type { ContextDeps } from "../routers/deps";
import type { DocumentUrlSigner } from "../routers/document-url";
import { type IdTokenVerifier, createCognitoIdTokenVerifier, jwksBuffer } from "./jwt";
import { brokerLookupOf, createBrokerDirectory } from "./staff";

export const TEST_POOL = { userPoolId: "us-east-1_TESTPOOL1", clientId: "test-web-client", region: "us-east-1" } as const;
export const TEST_ISSUER = `https://cognito-idp.${TEST_POOL.region}.amazonaws.com/${TEST_POOL.userPoolId}`;
/** Where the pool publishes its keys; the only URI a verifier of TEST_POOL may fetch. */
export const TEST_JWKS_URI = `${TEST_ISSUER}/.well-known/jwks.json`;

export type TestClaims = Record<string, unknown>;

export interface TestIssuer {
  readonly kid: string;
  /** What the pool would publish at `<issuer>/.well-known/jwks.json`. */
  readonly jwks: Jwks & { readonly keys: readonly Jwk[] };
  /** Serves `jwks`; counts the requests so tests can assert the cache. */
  readonly fetcher: Fetcher & { requests: number };
  /** Signs an id token; `overrides` replace or (with `undefined`) remove default claims. */
  idToken(overrides?: TestClaims, header?: Record<string, unknown>): string;
  verifier(): IdTokenVerifier;
}

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signJwt(header: Record<string, unknown>, payload: TestClaims, privateKey: KeyObject): string {
  const signingInput = `${base64url(header)}.${base64url(payload)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export function createTestIssuer(options: { kid?: string; now?: () => Date } = {}): TestIssuer {
  const kid = options.kid ?? "test-key-1";
  const now = options.now ?? (() => new Date());
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const exported = publicKey.export({ format: "jwk" });
  const jwks = { keys: [{ kty: "RSA", n: exported.n ?? "", e: exported.e ?? "", kid, alg: "RS256", use: "sig" }] };

  const fetcher: TestIssuer["fetcher"] = {
    requests: 0,
    async fetch() {
      fetcher.requests += 1;
      return jwksBuffer(jwks);
    },
  };

  return {
    kid,
    jwks,
    fetcher,
    idToken(overrides = {}, header = {}) {
      const issuedAt = Math.floor(now().getTime() / 1000);
      const payload: TestClaims = {
        sub: "7f1c9d2e-0000-4000-8000-000000000001",
        iss: TEST_ISSUER,
        aud: TEST_POOL.clientId,
        token_use: "id",
        auth_time: issuedAt,
        iat: issuedAt,
        exp: issuedAt + 3600,
        "cognito:username": "7f1c9d2e-0000-4000-8000-000000000001",
        "cognito:groups": ["BROKER"],
        "custom:firmId": "firm-delta",
        "custom:role": "BROKER",
        email: "broker@example.test",
        ...overrides,
      };
      for (const [claim, value] of Object.entries(payload)) if (value === undefined) delete payload[claim];
      return signJwt({ alg: "RS256", typ: "JWT", kid, ...header }, payload, privateKey);
    },
    verifier: () => createCognitoIdTokenVerifier(TEST_POOL, { fetcher }),
  };
}

export interface TestBroker {
  readonly firmId: string;
  readonly brokerId: string;
  readonly role: ConsoleRole;
  /** Cognito `sub` bound by `console:invite`; empty leaves the row unbound. */
  readonly sub: string;
  readonly active?: boolean;
  readonly name?: string;
}

const REAL_STAMP = "2026-09-26T15:00:00.000Z";

/** Broker rows as the seed writes them (`Firms/BROKER#`, GSI1 `SUB#<sub>` once bound). */
export async function seedBrokers(stores: MemoryStores, brokers: readonly TestBroker[]): Promise<void> {
  await stores.seed.loadItems(
    "Firms",
    brokers.map((broker) => ({
      PK: `FIRM#${broker.firmId}`,
      SK: `BROKER#${broker.brokerId}`,
      entity: "Broker",
      createdAt: REAL_STAMP,
      updatedAt: REAL_STAMP,
      version: 1,
      synthetic: true,
      brokerId: broker.brokerId,
      firmId: broker.firmId,
      name: broker.name ?? "Persona ficticia",
      role: broker.role,
      active: broker.active ?? true,
      cognitoSub: broker.sub,
      ...(broker.sub === "" ? {} : { cognitoSubKey: `SUB#${broker.sub}` }),
    })),
  );
}

export interface TestContextDepsOptions {
  readonly verifier: IdTokenVerifier;
  readonly stores: MemoryStores;
  /** Real clock of the request (`auth_time` checks, audit stamps). */
  readonly now?: () => Date;
  /** Every log line, as JSON, for assertions. */
  readonly lines?: string[];
  readonly health?: readonly HealthCheck[];
  readonly whatsappMode?: ChannelMode;
}

/** Signs nothing: the link names the key, so a test can assert which object it points at. */
export const testDocumentUrls: DocumentUrlSigner = {
  sign: (key, filename) => Promise.resolve(`https://documents.s3.us-east-1.amazonaws.com/${key}?download=${encodeURIComponent(filename)}`),
};

/** `ContextDeps` over the in-memory connector: nothing leaves the process. */
export function testContextDeps(options: TestContextDepsOptions): ContextDeps {
  const now = options.now ?? (() => new Date());
  const { connector } = options.stores;
  return {
    verifier: options.verifier,
    brokers: createBrokerDirectory(brokerLookupOf(connector.firms), now),
    connector,
    totp: { isTotpEnabled: () => Promise.resolve(false) },
    documents: testDocumentUrls,
    whatsappMode: () => options.whatsappMode ?? "simulated",
    health: options.health ?? [],
    wallClock: now,
    loggerFor: (correlationId) => createLogger({ correlationId, level: "debug", now, sink: (line) => void options.lines?.push(line) }),
  };
}
