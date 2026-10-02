// Test-only doubles of the public sign-up (never imported by runtime code): an in-process Cognito that
// keeps users, groups and the codes it "mails" and runs the real `AuthPreSignUp` check of the ticket,
// an invoker that records the asynchronous events, a fixed set of subkeys, the edge headers CloudFront
// adds, and an `AccessDeps` over the in-memory connector. The unit tests, the local flows and the
// local UI server use them (docs/test-plan.md §2: "Cognito es un doble en proceso").
import { LEGAL_VERSIONS } from "@legajo/shared/legal-versions";
import type { MemoryStores } from "../connector/index";
import { deriveSubkey, leadEmailHash, randomBase32 } from "../lib/crypto";
import { ORIGIN_VERIFY_HEADER, VIEWER_ADDRESS_HEADER } from "../lib/viewer-ip";
import { createLeadStore } from "../leads/store";
import type { MxResolver } from "./bot-checks";
import type { CognitoUser, ConfirmOutcome, SignUpRequest, SignupCognito } from "./cognito";
import { GUEST_GROUP } from "./cognito";
import type { AccessDeps, SignupKeys } from "./deps";
import type { EdgeGuard } from "./edge";
import type { AsyncInvoker, AsyncTarget } from "./invoke";
import { createSignupStore } from "./store";
import { verifyTicket } from "./ticket";

/** Test master key: the stage key is 32 random bytes of `SessionTokenKey`. */
export const TEST_MASTER_KEY = "test-master-key-test-master-key-00000000";
export const TEST_ORIGIN_KEY = "test-origin-verify-key-00000000000000000000";
export const TEST_VIEWER = "198.51.100.10:46532";

export const testEdgeGuard: EdgeGuard = { originVerifyKey: () => TEST_ORIGIN_KEY };

/** What CloudFront adds to every origin request of the Router. */
export function edgeHeaders(viewer: string = TEST_VIEWER): Record<string, string> {
  return { [ORIGIN_VERIFY_HEADER]: TEST_ORIGIN_KEY, [VIEWER_ADDRESS_HEADER]: viewer };
}

export function testSignupKeys(master: string = TEST_MASTER_KEY): SignupKeys {
  return {
    ticket: deriveSubkey(master, "signup-ticket"),
    seal: deriveSubkey(master, "signup-seal"),
    leadEmail: deriveSubkey(master, "lead-email"),
    rate: deriveSubkey(master, "rate"),
    form: deriveSubkey(master, "form"),
  };
}

interface FakeUser {
  username: string;
  sub: string;
  email: string;
  password: string;
  status: string;
  enabled: boolean;
  createdAt: Date;
  firmId?: string;
  groups: string[];
  locale?: string;
}

export interface SentCode {
  readonly kind: "SIGNUP" | "RESEND" | "FORGOT";
  readonly username: string;
  readonly code: string;
  readonly clientMetadata: Readonly<Record<string, string>>;
}

/** Every call the double received, by name, for "no write in Cognito" assertions. */
export type CognitoCall = keyof SignupCognito;

export interface FakeCognito extends SignupCognito {
  readonly users: Map<string, FakeUser>;
  readonly codes: SentCode[];
  readonly calls: CognitoCall[];
  /** Adds an existing user (staff, reserved guest, public guest, an unconfirmed one…). */
  seed(user: Partial<FakeUser> & { readonly username: string; readonly email: string }): void;
  lastCode(username: string): string | undefined;
}

const WRITES: readonly CognitoCall[] = ["deleteUnconfirmed", "signUp", "resendCode", "forgotPassword", "confirmSignUp", "confirmForgotPassword", "addGuestGroup", "deleteUser"];

export function cognitoWrites(calls: readonly CognitoCall[]): CognitoCall[] {
  return calls.filter((call) => WRITES.includes(call));
}

function view(user: FakeUser): CognitoUser {
  return { username: user.username, sub: user.sub, status: user.status, enabled: user.enabled, createdAt: user.createdAt, ...(user.firmId === undefined ? {} : { firmId: user.firmId }) };
}

/** An in-process Cognito: `SignUp` passes the ticket through the trigger's own check, like `AuthPreSignUp`. */
export function fakeCognito(options: { readonly keys?: SignupKeys; readonly now?: () => Date } = {}): FakeCognito {
  const keys = options.keys ?? testSignupKeys();
  const now = options.now ?? (() => new Date());
  const users = new Map<string, FakeUser>();
  const codes: SentCode[] = [];
  const calls: CognitoCall[] = [];
  let sequence = 0;
  const code = () => String(100_000 + (++sequence * 7_919) % 900_000);
  const record = (call: CognitoCall) => calls.push(call);
  const mail = (kind: SentCode["kind"], username: string, clientMetadata: Readonly<Record<string, string>>) => codes.push({ kind, username, code: code(), clientMetadata });
  const lastCode = (username: string) => [...codes].reverse().find((sent) => sent.username === username)?.code;
  const confirmWith = (username: string, given: string, kinds: readonly SentCode["kind"][]): ConfirmOutcome => {
    const user = users.get(username);
    const sent = [...codes].reverse().find((entry) => entry.username === username && kinds.includes(entry.kind));
    if (user === undefined || sent === undefined) return "NOT_CONFIRMABLE";
    return sent.code === given ? "CONFIRMED" : "CODE_MISMATCH";
  };

  return {
    users,
    codes,
    calls,
    lastCode,
    seed(user) {
      users.set(user.username, { sub: `sub-${user.username}`, password: "Seeded-Password-1", status: "CONFIRMED", enabled: true, createdAt: new Date("2026-09-01T00:00:00.000Z"), groups: [], ...user });
    },
    async findByEmail(email) {
      record("findByEmail");
      return [...users.values()].filter((user) => user.email === email).map(view);
    },
    async getUser(username) {
      record("getUser");
      const user = users.get(username);
      return user === undefined ? undefined : view(user);
    },
    async groupsOf(username) {
      record("groupsOf");
      return [...(users.get(username)?.groups ?? [])];
    },
    async deleteUnconfirmed(username) {
      record("deleteUnconfirmed");
      const user = users.get(username);
      if (user?.status !== "UNCONFIRMED" || user.groups.length > 0) return false;
      users.delete(username);
      return true;
    },
    async signUp(request: SignUpRequest) {
      record("signUp");
      const emailHash = leadEmailHash(keys.leadEmail, request.email);
      if (verifyTicket(keys.ticket, { username: request.username, emailHash }, request.validationData, now()) !== "VALID") throw Object.assign(new Error("PreSignUp failed with error the sign-up ticket is not valid."), { name: "UserLambdaValidationException" });
      if (users.has(request.username)) throw Object.assign(new Error("exists"), { name: "UsernameExistsException" });
      users.set(request.username, { username: request.username, sub: `sub-${request.username}`, email: request.email, password: request.password, status: "UNCONFIRMED", enabled: true, createdAt: now(), groups: [], locale: request.locale });
      mail("SIGNUP", request.username, request.clientMetadata);
    },
    async resendCode(username, clientMetadata) {
      record("resendCode");
      if (users.get(username)?.status === "UNCONFIRMED") mail("RESEND", username, clientMetadata);
    },
    async forgotPassword(username, clientMetadata) {
      record("forgotPassword");
      if (users.has(username)) mail("FORGOT", username, clientMetadata);
    },
    async confirmSignUp(username, given) {
      record("confirmSignUp");
      const outcome = confirmWith(username, given, ["SIGNUP", "RESEND"]);
      const user = users.get(username);
      if (outcome === "CONFIRMED" && user !== undefined) user.status = "CONFIRMED";
      return outcome;
    },
    async confirmForgotPassword(username, given, password) {
      record("confirmForgotPassword");
      const outcome = confirmWith(username, given, ["FORGOT"]);
      const user = users.get(username);
      if (outcome === "CONFIRMED" && user !== undefined) user.password = password;
      return outcome;
    },
    async addGuestGroup(username) {
      record("addGuestGroup");
      const user = users.get(username);
      if (user === undefined || user.groups.length > 0) return false;
      user.groups.push(GUEST_GROUP);
      return true;
    },
    async listUnconfirmed() {
      record("listUnconfirmed");
      return [...users.values()].filter((user) => user.status === "UNCONFIRMED").map(view);
    },
    async deleteUser(username) {
      record("deleteUser");
      users.delete(username);
    },
  };
}

export interface RecordedInvoke {
  readonly target: AsyncTarget;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function recordingInvoker(): AsyncInvoker & { readonly invoked: RecordedInvoke[] } {
  const invoked: RecordedInvoke[] = [];
  return {
    invoked,
    async invoke(target, payload) {
      invoked.push({ target, payload });
    },
  };
}

/** Every domain has a mail exchanger unless listed. */
export function fakeMx(noMail: readonly string[] = [], unknown: readonly string[] = []): MxResolver {
  return async (domain) => {
    if (unknown.includes(domain)) throw Object.assign(new Error("timeout"), { code: "ETIMEOUT" });
    if (noMail.includes(domain)) throw Object.assign(new Error("no data"), { code: "ENODATA" });
    return [{ exchange: `mx.${domain}`, priority: 10 }];
  };
}

export interface TestAccess extends AccessDeps {
  readonly cognito: FakeCognito;
  readonly invoker: AsyncInvoker & { readonly invoked: RecordedInvoke[] };
  /** Milliseconds `sleep` was asked for, in order (padded answers). */
  readonly slept: number[];
}

/** `AccessDeps` over the in-memory connector; `now` is the real clock the test moves. */
export function testAccessDeps(stores: MemoryStores, options: { readonly now?: () => Date; readonly mx?: MxResolver } = {}): TestAccess {
  const now = options.now ?? (() => new Date("2026-10-14T13:30:00.000Z"));
  const keys = testSignupKeys();
  const slept: number[] = [];
  let ulids = 0;
  return {
    client: stores.client,
    signups: createSignupStore(stores.client),
    leads: createLeadStore(stores.client),
    cognito: fakeCognito({ keys, now }),
    invoker: recordingInvoker(),
    keys,
    legalVersions: LEGAL_VERSIONS,
    appOrigin: "https://legajo.demo.craftech.io",
    now,
    slept,
    sleep: async (ms) => {
      slept.push(ms);
    },
    newUlid: () => `01J9ZQ${String(++ulids).padStart(20, "0")}`,
    newSignupId: () => randomBase32(26),
    resolveMx: options.mx ?? fakeMx(),
  };
}
