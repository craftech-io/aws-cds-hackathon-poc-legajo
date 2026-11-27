// What a console request needs besides its input. Procedures reach the domain through `ctx.deps`
// so tests swap every adapter (auth/testing.ts `testContextDeps`); the defaults are built once per
// Lambda container and read the linked resources lazily, on first use (lib/resource.ts, never
// `process.env`):
//
//   Auth          pool id and web client id: the only input of the id-token verifier, whose JWKS
//                 URI derives from the pool id (no option, header or variable can change it)
//   Firms …       the connector's tables (broker directory, firm fence, feature routers)
//   PlatformMock  `url` of the mock's Function URL, probed by `GET /api/health`
//   Documents     bucket of the PDFs, for the 5-minute download links of `operations.documentUrl`
//   ChannelModes  WhatsApp mode: the phone simulator only answers in `simulated`, and costs say so
//   Leads         `PHONE#<sub>`: whether the session of the token passed the SMS code (ADR-0021)
import { z } from "zod";
import type { ChannelMode } from "@legajo/shared";
import { authConfig } from "../auth/config";
import { type IdTokenVerifier, createCognitoIdTokenVerifier } from "../auth/jwt";
import { type BrokerDirectory, brokerLookupOf, createBrokerDirectory } from "../auth/staff";
import { type TotpStatusReader, createCognitoTotpReader } from "../auth/totp";
import { type Connector, connector, tableClient } from "../connector/index";
import { type Logger, createLogger } from "../lib/log";
import { bucketName, channelMode, readLinked } from "../lib/resource";
import { isSessionCleared } from "../phone-verification/service";
import { createPhoneStore } from "../phone-verification/store";
import { sigV4Signer } from "../reader/signer";
import { type DocumentUrlSigner, s3DocumentUrlSigner } from "./document-url";
import { type HealthCheck, cachedHealthCheck, functionUrlHealthCheck } from "./health";

export interface ContextDeps {
  readonly verifier: IdTokenVerifier;
  /** Broker rows by Cognito `sub` (brokerId, role, active), cached per user for a minute. */
  readonly brokers: BrokerDirectory;
  /** The data ports: the firm fence resolves the owner of every id through them. */
  readonly connector: Connector;
  readonly totp: TotpStatusReader;
  /** Download links of document versions (`operations.documentUrl`). */
  readonly documents: DocumentUrlSigner;
  /** `ChannelModes.whatsapp`, read when a procedure needs it. */
  readonly whatsappMode: () => ChannelMode;
  /** Dependencies `GET /api/health` probes. */
  readonly health: readonly HealthCheck[];
  /** Whether this sign-in session passed the SMS code, or the account is an automation (routers/phone-gate.ts). */
  readonly phoneGate: (sub: string, sessionId: string) => Promise<boolean>;
  /** Real time: `auth_time` comes from Cognito's clock, never from a world clock. */
  readonly wallClock: () => Date;
  /** One logger per request, bound to its correlation id. */
  readonly loggerFor: (correlationId: string) => Logger;
}

const FunctionUrlLink = z.object({ url: z.url() });

// A public probe answers from this cache for half a minute (routers/health.ts).
const HEALTH_CACHE_MS = 30_000;

let cached: ContextDeps | undefined;

export function defaultDeps(): ContextDeps {
  if (cached) return cached;
  const config = authConfig();
  const data = connector();
  const wallClock = () => new Date();
  cached = {
    verifier: createCognitoIdTokenVerifier(config),
    brokers: createBrokerDirectory(brokerLookupOf(data.firms), wallClock),
    connector: data,
    totp: createCognitoTotpReader(config),
    documents: s3DocumentUrlSigner({ bucket: () => bucketName("Documents") }),
    whatsappMode: () => channelMode("whatsapp"),
    health: [
      cachedHealthCheck(functionUrlHealthCheck({ name: "platform", endpoint: () => readLinked("PlatformMock", FunctionUrlLink).url, sign: sigV4Signer() }), {
        ttlMs: HEALTH_CACHE_MS,
        now: wallClock,
      }),
    ],
    phoneGate: (() => {
      let phones: ReturnType<typeof createPhoneStore> | undefined;
      return (sub: string, sessionId: string) => {
        phones ??= createPhoneStore(tableClient());
        return isSessionCleared({ phones, now: wallClock }, sub, sessionId);
      };
    })(),
    wallClock,
    loggerFor: (correlationId) => createLogger({ correlationId, bindings: { service: "bff" } }),
  };
  return cached;
}

/** Test seam: forget the container's dependencies. */
export function resetDefaultDeps(): void {
  cached = undefined;
}
