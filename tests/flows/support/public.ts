// The public edge of a local world (docs/test-plan.md §3, flows FL-101 onwards): the real BFF Lambda entry
// (routers/handler.ts) behind Function URL events as CloudFront forwards them, the sign-up over the
// Cognito double that checks the ticket like `AuthPreSignUp` (signup/testing.ts), and the asynchronous
// Lambdas the BFF hands work to, run in process when the test settles: `SignupDispatch`, `LeadNotice`
// (the single SES client with the `LEAD_NOTICE` profile, recorded by the SES fake) and `WorldJanitor`
// (the real world factory over the seed's `guest` template). Id tokens carry what the real `AuthPreToken`
// decides from the broker rows of the world; nothing of the edge is reimplemented here.
import { decidePreToken, guestRowsOf } from "@legajo/bff/auth-triggers/pre-token";
import { brokerLookupOf } from "@legajo/bff/auth/staff";
import { createEmailClient } from "@legajo/bff/channels/email/outbound";
import { createWorldJanitorHandler } from "@legajo/bff/handlers/world-janitor";
import { notifyLead } from "@legajo/bff/leads/notice/notice";
import type { AsyncTarget } from "@legajo/bff/signup/invoke";
import { runDispatch } from "@legajo/bff/signup/dispatch";
import { type RecordedInvoke, type TestAccess, edgeHeaders, fakeCognito, testAccessDeps, testSignupKeys } from "@legajo/bff/signup/testing";
import { TEST_PASSWORD } from "@legajo/bff/signup/testing-flows";
import { type Bff, type CallResult, bffFor, call, trpcEvent } from "@legajo/bff/signup/testing-http";
import { SESv2Client } from "@aws-sdk/client-sesv2";
import { LOCAL_STAGE } from "./stage/context";
import { LOCAL_MASTER_KEY, type FlowWorld } from "./world";

/** `LeadNoticeTo` of a local world: one `@craftech.io` inbox of the test, never an address of the code. */
export const LOCAL_NOTICE_TO = "leads-local@craftech.io";
/** The time a person takes to fill the form (the minimum is 3 s, ADR-0015 §3.2). */
const FILLING_MS = 10_000;

export interface SignupOptions {
  readonly lang?: "es" | "en";
  readonly contact?: boolean;
  readonly website?: string;
  /** `ip:port` of the viewer CloudFront reports. */
  readonly viewer?: string;
  readonly password?: string;
}

export interface SignedUp {
  readonly signupId: string;
  readonly start: CallResult;
  readonly username?: string;
  readonly sub?: string;
}

export interface PublicEdge {
  readonly access: TestAccess;
  readonly bff: Bff;
  /** Asynchronous invocations the BFF and the sweeps handed on, in order. */
  readonly invoked: RecordedInvoke[];
  /** When false, `LeadNotice` fails at SES (the first attempt of FL-115). */
  sesUp: boolean;
  /** Lead writes that fail before one succeeds: a sign-up cut between `ConfirmSignUp` and its lead (FL-122). */
  failLeadWrites: number;
  api(method: "GET" | "POST", procedure: string, input: unknown, options?: { readonly token?: string; readonly viewer?: string; readonly edge?: Record<string, string> }): Promise<CallResult>;
  /** Runs every asynchronous invocation queued so far (and what those queue), as Lambda would. */
  settle(): Promise<void>;
  /** `signup.form` → the person fills it → `signup.start` → `SignupDispatch`. */
  startSignup(email: string, options?: SignupOptions): Promise<SignedUp>;
  /** The last code the Cognito double mailed to `email`. */
  codeOf(email: string): string | undefined;
  /** `signup.confirm` with the code mailed to `email`, then the work it handed on. */
  confirm(signupId: string, email: string, code?: string, password?: string): Promise<CallResult>;
  /** Sign-up and confirmation of a new visitor; answers its Cognito user. */
  signUp(email: string, options?: SignupOptions): Promise<{ readonly signupId: string; readonly username: string; readonly sub: string }>;
  /** An id token of the user with the claims the real `AuthPreToken` decides now. */
  tokenOf(email: string, authTime?: Date): Promise<string>;
}

export function createPublicEdge(world: FlowWorld): PublicEdge {
  const now = world.realNow;
  // The sign-up's subkeys come from the world's master key, like every other subkey of the stage
  // (`ChannelEvents` marks a bounce under the same `lead-email` hash `SignupDispatch` reads).
  const keys = testSignupKeys(new TextDecoder().decode(LOCAL_MASTER_KEY));
  const base = { ...testAccessDeps(world.stores, { now }), keys, cognito: fakeCognito({ keys, now }) };
  const invoked: RecordedInvoke[] = [];
  const queue: RecordedInvoke[] = [];
  const leads = base.leads;
  const access: TestAccess = {
    ...base,
    leads: {
      ...leads,
      async saveVerifiedLead(input, at) {
        if (edge.failLeadWrites > 0) {
          edge.failLeadWrites -= 1;
          throw new Error("Leads is not reachable (the test cuts the sign-up here)");
        }
        return leads.saveVerifiedLead(input, at);
      },
    },
    invoker: {
      invoked,
      async invoke(target: AsyncTarget, payload: Readonly<Record<string, unknown>>) {
        invoked.push({ target, payload });
        queue.push({ target, payload });
      },
    },
  };
  const bff = bffFor(world.stores, access);
  const log = world.stage.log;
  const ses = new SESv2Client({ region: "us-east-1" });
  const noticeClient = createEmailClient({ fence: world.stage.fence, world: world.data.world, runtime: world.data.runtime, audit: world.data.audit, configurationSet: (profile) => `legajo-local-${profile.toLowerCase()}`, stage: LOCAL_STAGE, now, newMailId: () => `notice-${invoked.length}`, log, ses });
  const janitor = createWorldJanitorHandler({
    purge: { memory: world.worlds.memory, data: world.data, log, now, sleep: async () => undefined },
    worlds: (continuePurge) => ({ ...world.worlds, continuePurge }),
    sweep: () => access,
  });
  const edge: PublicEdge = {
    access,
    bff,
    invoked,
    sesUp: true,
    failLeadWrites: 0,
    api: (method, procedure, input, options = {}) =>
      call(bff, trpcEvent(method, `/api/${procedure}`, { input, edge: options.edge ?? edgeHeaders(options.viewer), ...(options.token === undefined ? {} : { headers: { "x-legajo-auth": `Bearer ${options.token}` } }) })),
    async settle() {
      while (queue.length > 0) {
        const next = queue.shift() as RecordedInvoke;
        if (next.target === "SignupDispatch") await runDispatch(access, next.payload, log);
        else if (next.target === "LeadNotice") await notifyLead({ leads: access.leads, email: { send: (request) => (edge.sesUp ? noticeClient.send(request) : Promise.reject(new Error("SES is down"))) }, recipients: () => LOCAL_NOTICE_TO, now, log }, next.payload);
        else if (next.target === "WorldJanitor") await janitor(next.payload);
      }
    },
    async startSignup(email, options = {}) {
      const viewer = options.viewer;
      const form = await edge.api("GET", "signup.form", { lang: options.lang ?? "es" }, viewer === undefined ? {} : { viewer });
      const formToken = (form.data as { formToken: string }).formToken;
      world.advanceReal(FILLING_MS);
      const start = await edge.api(
        "POST",
        "signup.start",
        {
          formToken,
          email,
          password: options.password ?? TEST_PASSWORD,
          consents: { terms: true, contact: options.contact ?? true },
          consentVersions: { ...access.legalVersions },
          lang: options.lang ?? "es",
          website: options.website ?? "",
        },
        viewer === undefined ? {} : { viewer },
      );
      await edge.settle();
      const user = [...access.cognito.users.values()].find((candidate) => candidate.email === email);
      return { signupId: (start.data as { signupId?: string } | undefined)?.signupId ?? "", start, ...(user === undefined ? {} : { username: user.username, sub: user.sub }) };
    },
    codeOf(email) {
      const user = [...access.cognito.users.values()].find((candidate) => candidate.email === email);
      return user === undefined ? undefined : access.cognito.lastCode(user.username);
    },
    async confirm(signupId, email, code, password) {
      const answer = await edge.api("POST", "signup.confirm", { signupId, code: code ?? edge.codeOf(email) ?? "000000", password: password ?? TEST_PASSWORD });
      await edge.settle();
      return answer;
    },
    async signUp(email, options = {}) {
      const started = await edge.startSignup(email, options);
      const confirmed = await edge.confirm(started.signupId, email, undefined, options.password);
      if ((confirmed.data as { status?: string } | undefined)?.status !== "CONFIRMED") throw new Error(`the sign-up was not confirmed: ${JSON.stringify(confirmed)}`);
      const user = [...access.cognito.users.values()].find((candidate) => candidate.email === email);
      if (user === undefined) throw new Error("the Cognito double has no user for that email");
      return { signupId: started.signupId, username: user.username, sub: user.sub };
    },
    async tokenOf(email, authTime = now()) {
      const user = [...access.cognito.users.values()].find((candidate) => candidate.email === email);
      if (user === undefined) throw new Error("no such user in the Cognito double");
      const decision = await decidePreToken(
        { version: "2", triggerSource: "TokenGeneration_Authentication", userPoolId: "us-east-1_LOCAL", userName: user.username, request: { userAttributes: { sub: user.sub, email: user.email }, groupConfiguration: { groupsToOverride: [...user.groups] } } },
        { brokers: brokerLookupOf(world.data.firms), guestRows: guestRowsOf(world.stores.client), log },
      );
      const details = decision.details;
      const suppressed = new Set<string>(details.idTokenGeneration.claimsToSuppress ?? []);
      // A suppressed claim is absent from the token (the issuer drops `undefined` claims).
      const claims = { "custom:firmId": undefined, ...Object.fromEntries(Object.entries(details.idTokenGeneration.claimsToAddOrOverride ?? {}).filter(([name]) => !suppressed.has(name))) };
      return bff.issuer.idToken({ sub: user.sub, "cognito:username": user.username, email: user.email, "cognito:groups": details.groupOverrideDetails.groupsToOverride ?? [...user.groups], auth_time: Math.floor(authTime.getTime() / 1000), ...claims });
    },
  };
  return edge;
}
