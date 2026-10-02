// The sign-up side of the local UI server (docs/test-plan.md §3, "Superficies públicas"): the real
// `signup.*` services over the in-memory `Runtime` and `Leads`, `SignupDispatch` run in process right
// after the BFF answers (as Lambda's asynchronous invocation would), `LeadNotice` recorded, and the user
// pool with the real triggers (triggers.ts). Keys are random per server process. The MX lookup answers
// for any domain, so a spec can sign up with a fictitious address; the reserved and own domains are still
// refused by the real checks. Nothing here ships in a Lambda.
import { randomBytes, randomUUID } from "node:crypto";
import { LEAD_NOTICE_DOMAIN } from "@legajo/bff/channels/email/fence";
import type { EmailSendRequest, EmailSendResult } from "@legajo/bff/channels/email/outbound";
import { notifyLead } from "@legajo/bff/leads/notice/notice";
import type { MemoryStores } from "@legajo/bff/connector/index";
import { randomBase32, ulid } from "@legajo/bff/lib/crypto";
import { createLogger } from "@legajo/bff/lib/log";
import { createLeadStore } from "@legajo/bff/leads/store";
import type { AccessDeps, SignupKeys } from "@legajo/bff/signup/deps";
import { runDispatch } from "@legajo/bff/signup/dispatch";
import type { AsyncInvoker, AsyncTarget } from "@legajo/bff/signup/invoke";
import { createSignupStore } from "@legajo/bff/signup/store";
import { LEGAL_VERSIONS } from "@legajo/shared/legal-versions";
import { realPoolTriggers } from "./triggers";
import { UserPool } from "./user-pool";

const log = createLogger({ level: "warn", bindings: { service: "ui-server-signup" } });

export interface RecordedInvocation {
  readonly target: AsyncTarget;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface LocalAccess {
  readonly deps: AccessDeps;
  readonly pool: UserPool;
  /** Every asynchronous invocation, in order (a spec checks that a lead notice went out once). */
  readonly invocations: RecordedInvocation[];
  /** What the fake SES took from `LeadNotice`: never mailed. */
  readonly notices: EmailSendRequest[];
  /** Resolves when every dispatch queued so far has run. */
  settled(): Promise<void>;
}

function keys(): SignupKeys {
  return { ticket: randomBytes(32), seal: randomBytes(32), leadEmail: randomBytes(32), rate: randomBytes(32), form: randomBytes(32) };
}

export function createLocalAccess(stores: MemoryStores, poolId: string, appOrigin: string, now: () => Date): LocalAccess {
  const signupKeys = keys();
  const pool = new UserPool(poolId, realPoolTriggers(stores, signupKeys, now), now);
  const invocations: RecordedInvocation[] = [];
  const notices: EmailSendRequest[] = [];
  const queue: Promise<unknown>[] = [];
  // The single SES client, faked: it keeps the notice and answers as SES accepts one.
  const fakeSes = {
    async send(request: EmailSendRequest): Promise<EmailSendResult> {
      notices.push(request);
      return { status: "SENT", providerMessageId: randomUUID(), rfcMessageId: `<${randomUUID()}@ui-server.local>`, awaiting: "SES_EVENT", from: "ui-server", to: request.to };
    },
  };
  // A recipient of the notice fence's own domain, for this server only (the stage reads `LeadNoticeTo`).
  const noticeRecipient = `ui-server-notices@${LEAD_NOTICE_DOMAIN}`;

  const invoker: AsyncInvoker = {
    async invoke(target, payload) {
      invocations.push({ target, payload });
      // Accepted at once; the work runs after the BFF's answer, like `InvocationType: Event`.
      const later = new Promise((resolve) => setImmediate(resolve));
      if (target === "SignupDispatch") queue.push(later.then(() => runDispatch(deps, payload, log)).catch(() => undefined));
      if (target === "LeadNotice") {
        queue.push(later.then(() => notifyLead({ leads: deps.leads, email: fakeSes, recipients: () => noticeRecipient, now, log }, payload)).catch(() => undefined));
      }
    },
  };

  const deps: AccessDeps = {
    client: stores.client,
    signups: createSignupStore(stores.client),
    leads: createLeadStore(stores.client),
    cognito: pool.admin,
    invoker,
    keys: signupKeys,
    legalVersions: LEGAL_VERSIONS,
    appOrigin,
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newUlid: () => ulid(now().getTime()),
    newSignupId: () => randomBase32(26),
    resolveMx: async (domain) => [{ exchange: `mx.${domain}`, priority: 10 }],
  };

  return {
    deps,
    pool,
    invocations,
    notices,
    async settled() {
      await Promise.all(queue);
    },
  };
}
