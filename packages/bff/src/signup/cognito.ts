// The one Cognito client of the sign-up (ADR-0015 §1 and §1.2): `SignupDispatch` classifies and acts,
// `signup.confirm` confirms, `finalizeSignup` grants the `GUEST` group and the janitor sweeps users that
// never confirmed. Two fences live here and nowhere else, so no caller can skip them:
//
//   deleteUnconfirmed   deletes only a user that is UNCONFIRMED and has no group at that moment
//   addGuestGroup       adds only the literal group GUEST, only to a user with no group at that moment
//
// Every call carries the SDK timeout and a backoff retry on throttling (lib/clients.ts, lib/retry.ts).
import {
  AdminAddUserToGroupCommand,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  type AttributeType,
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ConfirmSignUpCommand,
  ForgotPasswordCommand,
  ListUsersCommand,
  ResendConfirmationCodeCommand,
  SignUpCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { awsClientConfig } from "../lib/clients";
import { withRetry } from "../lib/retry";
import { COGNITO_TIMEOUTS } from "../auth/totp";

export interface CognitoUser {
  readonly username: string;
  /** `UNCONFIRMED`, `CONFIRMED`, `FORCE_CHANGE_PASSWORD`, `RESET_REQUIRED`, … */
  readonly status: string;
  readonly enabled: boolean;
  readonly createdAt: Date;
  /** `custom:firmId`: set only for staff and reserved guest accounts. */
  readonly firmId?: string;
  /** The user's `sub`: the key of its world lease (`GUESTWORLD#<sub>`). */
  readonly sub?: string;
}

export type ConfirmOutcome = "CONFIRMED" | "CODE_MISMATCH" | "EXPIRED_CODE" | "TOO_MANY" | "NOT_CONFIRMABLE";

export interface SignUpRequest {
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly locale: "es" | "en";
  readonly validationData: Readonly<Record<string, string>>;
  readonly clientMetadata: Readonly<Record<string, string>>;
}

/** The single guest group a self-service account may ever get. */
export const GUEST_GROUP = "GUEST";

export interface SignupCognito {
  findByEmail(email: string): Promise<CognitoUser[]>;
  getUser(username: string): Promise<CognitoUser | undefined>;
  groupsOf(username: string): Promise<string[]>;
  /** Fence: only an `UNCONFIRMED` user without groups, read right before; false when it was not deleted. */
  deleteUnconfirmed(username: string): Promise<boolean>;
  signUp(request: SignUpRequest): Promise<void>;
  resendCode(username: string, clientMetadata: Readonly<Record<string, string>>): Promise<void>;
  forgotPassword(username: string, clientMetadata: Readonly<Record<string, string>>): Promise<void>;
  confirmSignUp(username: string, code: string): Promise<ConfirmOutcome>;
  confirmForgotPassword(username: string, code: string, password: string): Promise<ConfirmOutcome>;
  /** Fence: GUEST only, only to a user with no group, read right before; false when it already had one. */
  addGuestGroup(username: string): Promise<boolean>;
  /** Users still `UNCONFIRMED` (the hourly sweep). */
  listUnconfirmed(): Promise<CognitoUser[]>;
  /** Deletes a user of a lead (`leads:delete`, retention); a missing user is not an error. */
  deleteUser(username: string): Promise<void>;
}

export interface CognitoConfig {
  readonly userPoolId: string;
  readonly clientId: string;
  readonly region: string;
}

const RETRYABLE = new Set(["TooManyRequestsException", "InternalErrorException", "TimeoutError", "ThrottlingException"]);
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : "");

function attribute(attributes: readonly AttributeType[] | undefined, name: string): string | undefined {
  return attributes?.find((item) => item.Name === name)?.Value;
}

function toUser(user: Pick<UserType, "Username" | "UserStatus" | "Enabled" | "UserCreateDate" | "Attributes">): CognitoUser {
  const firmId = attribute(user.Attributes, "custom:firmId");
  const sub = attribute(user.Attributes, "sub");
  return {
    username: user.Username ?? "",
    status: user.UserStatus ?? "UNKNOWN",
    enabled: user.Enabled !== false,
    createdAt: user.UserCreateDate ?? new Date(0),
    ...(firmId === undefined || firmId === "" ? {} : { firmId }),
    ...(sub === undefined ? {} : { sub }),
  };
}

const CONFIRM_ERRORS: Readonly<Record<string, ConfirmOutcome>> = {
  CodeMismatchException: "CODE_MISMATCH",
  ExpiredCodeException: "EXPIRED_CODE",
  TooManyFailedAttemptsException: "TOO_MANY",
  LimitExceededException: "TOO_MANY",
  NotAuthorizedException: "NOT_CONFIRMABLE",
  UserNotFoundException: "NOT_CONFIRMABLE",
  InvalidPasswordException: "NOT_CONFIRMABLE",
};

/** `email = "<address>"` of ListUsers, quotes and backslashes escaped. */
export function emailFilter(email: string): string {
  return `email = "${email.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function createSignupCognito(config: CognitoConfig, client = new CognitoIdentityProviderClient({ region: config.region, ...awsClientConfig(COGNITO_TIMEOUTS) })): SignupCognito {
  const send = <T>(call: () => Promise<T>) => withRetry(call, { attempts: 3, baseDelayMs: 100, shouldRetry: (error) => RETRYABLE.has(nameOf(error)) });
  const pool = { UserPoolId: config.userPoolId };

  async function getUser(username: string): Promise<CognitoUser | undefined> {
    try {
      const user = await send(() => client.send(new AdminGetUserCommand({ ...pool, Username: username })));
      return toUser({ Username: user.Username, UserStatus: user.UserStatus, Enabled: user.Enabled, UserCreateDate: user.UserCreateDate, Attributes: user.UserAttributes });
    } catch (error) {
      if (nameOf(error) === "UserNotFoundException") return undefined;
      throw error;
    }
  }

  async function groupsOf(username: string): Promise<string[]> {
    const output = await send(() => client.send(new AdminListGroupsForUserCommand({ ...pool, Username: username, Limit: 10 })));
    return (output.Groups ?? []).flatMap((group) => (group.GroupName === undefined ? [] : [group.GroupName]));
  }

  async function confirm(call: () => Promise<unknown>): Promise<ConfirmOutcome> {
    try {
      await send(call);
      return "CONFIRMED";
    } catch (error) {
      const outcome = CONFIRM_ERRORS[nameOf(error)];
      if (outcome !== undefined) return outcome;
      throw error;
    }
  }

  async function listUsers(filter: string, limit?: number): Promise<CognitoUser[]> {
    const users: CognitoUser[] = [];
    let token: string | undefined;
    do {
      const output = await send(() => client.send(new ListUsersCommand({ ...pool, Filter: filter, Limit: 60, PaginationToken: token })));
      users.push(...(output.Users ?? []).map(toUser));
      token = output.PaginationToken;
    } while (token !== undefined && (limit === undefined || users.length < limit));
    return users;
  }

  return {
    findByEmail: (email) => listUsers(emailFilter(email), 2),
    getUser,
    groupsOf,

    async deleteUnconfirmed(username) {
      const user = await getUser(username);
      if (user?.status !== "UNCONFIRMED" || (await groupsOf(username)).length > 0) return false;
      await send(() => client.send(new AdminDeleteUserCommand({ ...pool, Username: username })));
      return true;
    },

    async signUp(request) {
      await send(() =>
        client.send(
          new SignUpCommand({
            ClientId: config.clientId,
            Username: request.username,
            Password: request.password,
            UserAttributes: [
              { Name: "email", Value: request.email },
              { Name: "locale", Value: request.locale },
            ],
            ValidationData: Object.entries(request.validationData).map(([Name, Value]) => ({ Name, Value })),
            ClientMetadata: { ...request.clientMetadata },
          }),
        ),
      );
    },

    async resendCode(username, clientMetadata) {
      await send(() => client.send(new ResendConfirmationCodeCommand({ ClientId: config.clientId, Username: username, ClientMetadata: { ...clientMetadata } })));
    },

    async forgotPassword(username, clientMetadata) {
      await send(() => client.send(new ForgotPasswordCommand({ ClientId: config.clientId, Username: username, ClientMetadata: { ...clientMetadata } })));
    },

    confirmSignUp: (username, code) => confirm(() => client.send(new ConfirmSignUpCommand({ ClientId: config.clientId, Username: username, ConfirmationCode: code }))),

    confirmForgotPassword: (username, code, password) =>
      confirm(() => client.send(new ConfirmForgotPasswordCommand({ ClientId: config.clientId, Username: username, ConfirmationCode: code, Password: password }))),

    async addGuestGroup(username) {
      if ((await groupsOf(username)).length > 0) return false;
      await send(() => client.send(new AdminAddUserToGroupCommand({ ...pool, Username: username, GroupName: GUEST_GROUP })));
      return true;
    },

    listUnconfirmed: () => listUsers('cognito:user_status = "UNCONFIRMED"'),

    async deleteUser(username) {
      try {
        await send(() => client.send(new AdminDeleteUserCommand({ ...pool, Username: username })));
      } catch (error) {
        if (nameOf(error) !== "UserNotFoundException") throw error;
      }
    },
  };
}
