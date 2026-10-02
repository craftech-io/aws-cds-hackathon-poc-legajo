// In-memory Cognito user pool of the local UI server (docs/test-plan.md §2, level UI). One set of
// users, codes and tokens behind two doors: the administration API that `SignupDispatch`,
// `signup.confirm` and `finalizeSignup` call in process (the `SignupCognito` interface of
// packages/bff/src/signup/cognito.ts, with its two fences), and the browser's API (browser-api.ts).
// Every email Cognito would send goes through the pool's triggers (triggers.ts wires the real ones)
// and is kept, code included, so a spec can read it from the server's test-only route. Errors carry
// Cognito's exception names, like the SDK's. Nothing here ships in a Lambda.
import { randomInt, randomUUID } from "node:crypto";
import type { CognitoUser, ConfirmOutcome, SignupCognito, SignUpRequest } from "@legajo/bff/signup/cognito";
import { GUEST_GROUP } from "@legajo/bff/signup/cognito";
import { type SrpVerifier, createVerifier } from "../../../packages/web/src/lib/auth/testing/srp-server";

export type UserStatus = "UNCONFIRMED" | "CONFIRMED" | "FORCE_CHANGE_PASSWORD";

export interface PoolUser {
  readonly username: string;
  readonly sub: string;
  readonly email: string | undefined;
  status: UserStatus;
  enabled: boolean;
  readonly createdAt: Date;
  groups: string[];
  locale: "es" | "en";
  /** `custom:firmId`: staff and reserved guest accounts only. */
  readonly firmId: string | undefined;
  srp: SrpVerifier;
  signupCode: string | undefined;
  resetCode: string | undefined;
}

export type EmailKind = "SIGNUP" | "RESEND" | "FORGOT" | "EXISTING";

export interface SentEmail {
  readonly to: string;
  readonly kind: EmailKind;
  readonly code: string;
  readonly subject: string;
  readonly body: string;
  readonly at: Date;
}

export interface MessageRequest {
  readonly triggerSource: "CustomMessage_SignUp" | "CustomMessage_ResendCode" | "CustomMessage_ForgotPassword";
  readonly user: PoolUser;
  readonly clientMetadata: Readonly<Record<string, string>>;
}

export interface PoolTriggers {
  /** `AuthPreSignUp`: throws to refuse the sign-up before the user exists and before any email. */
  preSignUp(user: { readonly username: string; readonly email: string }, validationData: Readonly<Record<string, string>>): Promise<void>;
  /** `AuthCustomMessage`: the email for the code placeholder, or a throw that stops it (a quota, a bounce). */
  customMessage(request: MessageRequest): Promise<{ readonly subject: string; readonly body: string }>;
}

export function cognitoFault(type: string, message: string): Error {
  const error = new Error(message);
  error.name = type;
  return error;
}

const KIND_OF: Readonly<Record<MessageRequest["triggerSource"], EmailKind>> = {
  CustomMessage_SignUp: "SIGNUP",
  CustomMessage_ResendCode: "RESEND",
  CustomMessage_ForgotPassword: "FORGOT",
};

export class UserPool {
  readonly sent: SentEmail[] = [];
  private readonly users = new Map<string, PoolUser>();

  constructor(
    readonly poolId: string,
    private readonly triggers: PoolTriggers,
    private readonly now: () => Date,
  ) {}

  /** An account the operator would invite: a reserved guest (username, no email) or staff. */
  async addConfirmed(init: { readonly username: string; readonly email?: string; readonly password: string; readonly groups: readonly string[]; readonly firmId?: string; readonly sub?: string }): Promise<PoolUser> {
    const user: PoolUser = {
      username: init.username,
      sub: init.sub ?? randomUUID(),
      email: init.email?.toLowerCase(),
      status: "CONFIRMED",
      enabled: true,
      createdAt: this.now(),
      groups: [...init.groups],
      locale: "es",
      firmId: init.firmId,
      srp: await createVerifier(this.poolId, init.username, init.password),
      signupCode: undefined,
      resetCode: undefined,
    };
    this.users.set(user.username, user);
    return user;
  }

  /** By username, or by email (an alias of the pool, as in infra/auth.ts). */
  find(login: string): PoolUser | undefined {
    const name = login.trim().toLowerCase();
    return this.users.get(name) ?? [...this.users.values()].find((user) => user.email === name);
  }

  bySub(sub: string): PoolUser | undefined {
    return [...this.users.values()].find((user) => user.sub === sub);
  }

  lastEmailTo(address: string): SentEmail | undefined {
    const to = address.trim().toLowerCase();
    return this.sent.filter((email) => email.to === to).at(-1);
  }

  private newCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, "0");
  }

  async setPassword(user: PoolUser, password: string): Promise<void> {
    user.srp = await createVerifier(this.poolId, user.username, password);
  }

  /** Mints a code and sends it through `AuthCustomMessage`; a refusing trigger fails the call, as Cognito does. */
  async sendCode(user: PoolUser, triggerSource: MessageRequest["triggerSource"], clientMetadata: Readonly<Record<string, string>>): Promise<void> {
    if (!user.email) return;
    const code = this.newCode();
    if (triggerSource === "CustomMessage_ForgotPassword") user.resetCode = code;
    else user.signupCode = code;
    let message: { readonly subject: string; readonly body: string };
    try {
      message = await this.triggers.customMessage({ triggerSource, user, clientMetadata });
    } catch {
      throw cognitoFault("UserLambdaValidationException", "CustomMessage failed with error.");
    }
    const kind = clientMetadata.intent === "signup-existing" ? "EXISTING" : KIND_OF[triggerSource];
    this.sent.push({ to: user.email, kind, code, subject: message.subject.replaceAll("{####}", code), body: message.body.replaceAll("{####}", code), at: this.now() });
  }

  private toCognitoUser(user: PoolUser): CognitoUser {
    return { username: user.username, status: user.status, enabled: user.enabled, createdAt: user.createdAt, ...(user.firmId ? { firmId: user.firmId } : {}) };
  }

  /** What `SignupDispatch` and friends call in process (packages/bff/src/signup/cognito.ts). */
  readonly admin: SignupCognito = {
    findByEmail: async (email) => [...this.users.values()].filter((user) => user.email === email.toLowerCase()).map((user) => this.toCognitoUser(user)),
    getUser: async (username) => {
      const user = this.users.get(username);
      return user ? this.toCognitoUser(user) : undefined;
    },
    groupsOf: async (username) => [...(this.users.get(username)?.groups ?? [])],
    deleteUnconfirmed: async (username) => {
      const user = this.users.get(username);
      if (user?.status !== "UNCONFIRMED" || user.groups.length > 0) return false;
      this.users.delete(username);
      return true;
    },
    signUp: async (request: SignUpRequest) => {
      if (this.users.has(request.username)) throw cognitoFault("UsernameExistsException", "User already exists");
      try {
        await this.triggers.preSignUp({ username: request.username, email: request.email }, request.validationData);
      } catch {
        throw cognitoFault("UserLambdaValidationException", "PreSignUp failed with error.");
      }
      const user: PoolUser = {
        username: request.username,
        sub: randomUUID(),
        email: request.email.toLowerCase(),
        status: "UNCONFIRMED",
        enabled: true,
        createdAt: this.now(),
        groups: [],
        locale: request.locale,
        firmId: undefined,
        srp: await createVerifier(this.poolId, request.username, request.password),
        signupCode: undefined,
        resetCode: undefined,
      };
      this.users.set(user.username, user);
      await this.sendCode(user, "CustomMessage_SignUp", request.clientMetadata);
    },
    resendCode: async (username, clientMetadata) => {
      const user = this.users.get(username);
      if (!user || user.status !== "UNCONFIRMED") throw cognitoFault("InvalidParameterException", "User is already confirmed.");
      await this.sendCode(user, "CustomMessage_ResendCode", clientMetadata);
    },
    forgotPassword: async (username, clientMetadata) => {
      const user = this.users.get(username);
      if (!user) throw cognitoFault("UserNotFoundException", "Username/client id combination not found.");
      await this.sendCode(user, "CustomMessage_ForgotPassword", clientMetadata);
    },
    confirmSignUp: async (username, code): Promise<ConfirmOutcome> => {
      const user = this.users.get(username);
      if (!user || user.status !== "UNCONFIRMED") return "NOT_CONFIRMABLE";
      if (!user.signupCode || user.signupCode !== code) return "CODE_MISMATCH";
      user.status = "CONFIRMED";
      user.signupCode = undefined;
      return "CONFIRMED";
    },
    confirmForgotPassword: async (username, code, password): Promise<ConfirmOutcome> => {
      const user = this.users.get(username);
      if (!user) return "NOT_CONFIRMABLE";
      if (!user.resetCode || user.resetCode !== code) return "CODE_MISMATCH";
      await this.setPassword(user, password);
      user.resetCode = undefined;
      return "CONFIRMED";
    },
    addGuestGroup: async (username) => {
      const user = this.users.get(username);
      if (!user || user.groups.length > 0) return false;
      user.groups = [GUEST_GROUP];
      return true;
    },
    listUnconfirmed: async () => [...this.users.values()].filter((user) => user.status === "UNCONFIRMED").map((user) => this.toCognitoUser(user)),
    deleteUser: async (username) => {
      this.users.delete(username);
    },
  };
}
