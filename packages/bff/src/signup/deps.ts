// What the public sign-up, the guest bootstrap and the lead jobs need, in one set: tests and the local
// UI server pass their own (signup/testing.ts); the Lambdas build the default once per container from
// their links (`Resource`, never `process.env`): the connector's table client for `Runtime` and
// `Leads`, the pool and its web client (`Auth`), the functions they invoke, the `OriginVerifyKey`
// secret and the HKDF subkeys of `SessionTokenKey` (lib/secrets.ts).
import { LEGAL_VERSIONS } from "@legajo/shared/legal-versions";
import type { ConsentVersions } from "@legajo/shared/signup";
import { authConfig } from "../auth/config";
import { type TableClient, tableClient } from "../connector/index";
import { ulid, randomBase32 } from "../lib/crypto";
import { secretValue, subkey } from "../lib/secrets";
import { type LeadStore, createLeadStore } from "../leads/store";
import { APP_ORIGIN } from "../public-web/deps";
import { type MxResolver, systemMxResolver } from "./bot-checks";
import { type SignupCognito, createSignupCognito } from "./cognito";
import { type AsyncInvoker, lambdaAsyncInvoker } from "./invoke";
import { type SignupStore, createSignupStore } from "./store";

export interface SignupKeys {
  readonly ticket: Uint8Array;
  readonly seal: Uint8Array;
  readonly leadEmail: Uint8Array;
  readonly rate: Uint8Array;
  readonly form: Uint8Array;
}

export interface AccessDeps {
  /** `Runtime` (counters, mail status, breaker, slots, quotas) and `Leads`, through the connector's client. */
  readonly client: TableClient;
  readonly signups: SignupStore;
  readonly leads: LeadStore;
  readonly cognito: SignupCognito;
  readonly invoker: AsyncInvoker;
  readonly keys: SignupKeys;
  /** `LEGAL_VERSIONS`: a form shown with other texts is refused. */
  readonly legalVersions: ConsentVersions;
  /** `https://legajo.demo.craftech.io`: a referrer from it is not an origin of the visit. */
  readonly appOrigin: string;
  /** Real time: sign-ups, tickets, rate windows and leads are real-time facts, never a world's clock. */
  readonly now: () => Date;
  readonly sleep: (ms: number) => Promise<void>;
  readonly newUlid: () => string;
  readonly newSignupId: () => string;
  readonly resolveMx: MxResolver;
}

/** The two secrets of the public sign-up (infra/secrets.ts), through lib/secrets.ts. */
export function linkedSecret(name: "OriginVerifyKey" | "LeadNoticeTo"): string {
  return secretValue(name);
}

export function signupKeys(): SignupKeys {
  return { ticket: subkey("signup-ticket"), seal: subkey("signup-seal"), leadEmail: subkey("lead-email"), rate: subkey("rate"), form: subkey("form") };
}

let defaults: AccessDeps | undefined;

/** The Lambda's set, built on first use; reading a link that is missing fails then, not at import. */
export function defaultAccessDeps(): AccessDeps {
  if (defaults !== undefined) return defaults;
  const client = tableClient();
  const auth = authConfig();
  defaults = {
    client,
    signups: createSignupStore(client),
    leads: createLeadStore(client),
    cognito: createSignupCognito(auth),
    invoker: lambdaAsyncInvoker(),
    keys: signupKeys(),
    legalVersions: LEGAL_VERSIONS,
    appOrigin: APP_ORIGIN,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newUlid: () => ulid(),
    newSignupId: () => randomBase32(26),
    resolveMx: systemMxResolver,
  };
  return defaults;
}
