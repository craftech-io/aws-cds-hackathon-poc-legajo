// What the public sign-up, the guest bootstrap and the lead jobs need, in one set: tests and the local
// UI server pass their own (signup/testing.ts); the Lambdas build the default once per container from
// their links (`Resource`, never `process.env`): the connector's table client for `Runtime` and
// `Leads` (sign-ups, leads and the phone items of ADR-0021), the SNS sender of the SMS code, the pool and its web client (`Auth`), the functions they invoke, the `OriginVerifyKey`
// secret and the HKDF subkeys of `SessionTokenKey` (lib/secrets.ts).
import { LEGAL_VERSIONS } from "@legajo/shared/legal-versions";
import type { ConsentVersions } from "@legajo/shared/signup";
import { authConfig } from "../auth/config";
import { type TableClient, tableClient } from "../connector/index";
import { cognitoCallerTag, ulid, randomBase32 } from "../lib/crypto";
import { secretValue, subkey } from "../lib/secrets";
import { type LeadStore, createLeadStore } from "../leads/store";
import { APP_ORIGIN } from "../public-web/deps";
import { type AddressResolver, type MxResolver, systemAddressResolver, systemMxResolver } from "./bot-checks";
import { type SignupCognito, createSignupCognito } from "./cognito";
import { type AsyncInvoker, lambdaAsyncInvoker } from "./invoke";
import { type PhoneStore, createPhoneStore } from "../phone-verification/store";
import { type SmsSender, snsSmsSender } from "../phone-verification/sms";
import { newPhoneCode } from "../phone-verification/service";
import { type SignupStore, createSignupStore } from "./store";

export interface SignupKeys {
  readonly ticket: Uint8Array;
  readonly seal: Uint8Array;
  readonly leadEmail: Uint8Array;
  readonly rate: Uint8Array;
  readonly form: Uint8Array;
  /** HMAC of a verified number (`PHONENUM#`, one account each, ADR-0021). */
  readonly accountPhone: Uint8Array;
  /** HMAC of an SMS code: the only form a code is stored in. */
  readonly phoneCode: Uint8Array;
}

export interface AccessDeps {
  /** `Runtime` (counters, mail status, breaker, slots, quotas) and `Leads`, through the connector's client. */
  readonly client: TableClient;
  readonly signups: SignupStore;
  readonly leads: LeadStore;
  /** `Leads/PHONE#…` and `PHONENUM#…`: the SMS code of every sign-in session (ADR-0021). */
  readonly phones: PhoneStore;
  /** SNS `Publish` to the number in the Lambda; in memory everywhere else. */
  readonly sms: SmsSender;
  readonly newPhoneCode: () => string;
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
  /** A and AAAA of a mail server: a domain whose MX sits at a disposable service's address is disposable. */
  readonly resolveAddresses: AddressResolver;
}

/** The two secrets of the public sign-up (infra/secrets.ts), through lib/secrets.ts. */
export function linkedSecret(name: "OriginVerifyKey" | "LeadNoticeTo"): string {
  return secretValue(name);
}

export function signupKeys(): SignupKeys {
  return { ticket: subkey("signup-ticket"), seal: subkey("signup-seal"), leadEmail: subkey("lead-email"), rate: subkey("rate"), form: subkey("form"), accountPhone: subkey("account-phone"), phoneCode: subkey("phone-code") };
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
    phones: createPhoneStore(client),
    sms: snsSmsSender(),
    newPhoneCode,
    cognito: createSignupCognito({ ...auth, callerTag: cognitoCallerTag(subkey("cognito-caller")) }),
    invoker: lambdaAsyncInvoker(),
    keys: signupKeys(),
    legalVersions: LEGAL_VERSIONS,
    appOrigin: APP_ORIGIN,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newUlid: () => ulid(),
    newSignupId: () => randomBase32(26),
    resolveMx: systemMxResolver,
    resolveAddresses: systemAddressResolver,
  };
  return defaults;
}
