// The browser's side of the local UI server's user pool: the Cognito JSON 1.1 operations that
// packages/web/src/lib/auth/cognito.ts calls without credentials (SRP sign-in, refresh, revoke,
// "olvidé mi contraseña", the MFA lookup), answered as Cognito answers them. The Playwright specs route
// the real Cognito endpoint here (`/__cognito`), so the console runs its own client unchanged. SRP is
// really verified (srp-server.ts): a wrong password fails like it would. `preventUserExistenceErrors`
// holds: an unknown user gets a challenge that then fails, and a reset for one reads like a success.
// The id token's tenant, role and guest flag come from the pre-token trigger (triggers.ts).
import { z } from "zod";
import { type ServerSession, createVerifier, startServerSession } from "../../../packages/web/src/lib/auth/testing/srp-server";
import type { TokenIssuer } from "./token-issuer";
import { type PoolUser, UserPool, cognitoFault } from "./user-pool";

export type PreTokenClaims = (user: PoolUser) => Promise<{ readonly claims: Readonly<Record<string, string>>; readonly groups: readonly string[] }>;

interface Pending {
  readonly username: string | undefined;
  readonly session: ServerSession;
  readonly srpA: string;
}

interface Refresh {
  readonly username: string;
  readonly authTime: number;
}

const Body = z.looseObject({
  AuthFlow: z.string().optional(),
  AuthParameters: z.record(z.string(), z.string()).optional(),
  ChallengeName: z.string().optional(),
  ChallengeResponses: z.record(z.string(), z.string()).optional(),
  ClientMetadata: z.record(z.string(), z.string()).optional(),
  Username: z.string().optional(),
  ConfirmationCode: z.string().optional(),
  Password: z.string().optional(),
  Token: z.string().optional(),
  AccessToken: z.string().optional(),
});
type Body = z.infer<typeof Body>;

export interface CognitoAnswer {
  readonly status: number;
  readonly body: unknown;
}

export class BrowserCognito {
  /** Refresh tokens the console revoked (FL-108 asserts on them). */
  readonly revoked = new Set<string>();
  private readonly pending = new Map<string, Pending>();
  private readonly refreshTokens = new Map<string, Refresh>();
  private readonly accessTokens = new Map<string, string>();

  constructor(
    private readonly pool: UserPool,
    private readonly issuer: TokenIssuer,
    private readonly preToken: PreTokenClaims,
    private readonly now: () => Date,
  ) {}

  /** One request of the browser: `x-amz-target` names the operation. */
  async handle(target: string, raw: string): Promise<CognitoAnswer> {
    const operation = target.slice(target.lastIndexOf(".") + 1);
    try {
      const body = Body.parse(JSON.parse(raw || "{}"));
      return { status: 200, body: await this.dispatch(operation, body) };
    } catch (error) {
      const type = error instanceof Error && error.name !== "Error" && error.name !== "ZodError" ? error.name : "InvalidParameterException";
      return { status: 400, body: { __type: type, message: error instanceof Error ? error.message : "invalid request" } };
    }
  }

  private async dispatch(operation: string, body: Body): Promise<unknown> {
    switch (operation) {
      case "InitiateAuth":
        return body.AuthFlow === "REFRESH_TOKEN_AUTH" ? this.refresh(body.AuthParameters?.REFRESH_TOKEN ?? "") : this.startSrp(body.AuthParameters ?? {});
      case "RespondToAuthChallenge":
        if (body.ChallengeName !== "PASSWORD_VERIFIER") throw cognitoFault("InvalidParameterException", "unsupported challenge");
        return this.passwordVerifier(body.ChallengeResponses ?? {});
      case "RevokeToken":
        this.revoked.add(body.Token ?? "");
        this.refreshTokens.delete(body.Token ?? "");
        return {};
      case "ForgotPassword":
        return this.forgot(body.Username ?? "", body.ClientMetadata ?? {});
      case "ConfirmForgotPassword":
        return this.confirmForgot(body);
      case "GetUser":
        if (!this.accessTokens.has(body.AccessToken ?? "")) throw cognitoFault("NotAuthorizedException", "Invalid Access Token");
        return { Username: this.accessTokens.get(body.AccessToken ?? ""), UserMFASettingList: [] };
      default:
        throw cognitoFault("InvalidParameterException", `operation ${operation} is not part of the local pool`);
    }
  }

  private async startSrp(parameters: Readonly<Record<string, string>>): Promise<unknown> {
    const user = this.pool.find(parameters.USERNAME ?? "");
    const userId = user?.username ?? "usr-unknown";
    const record = user?.srp ?? (await createVerifier(this.pool.poolId, userId, crypto.randomUUID()));
    const session = await startServerSession(this.pool.poolId, record);
    this.pending.set(session.secretBlock, { username: user?.username, session, srpA: parameters.SRP_A ?? "" });
    return {
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: { SALT: record.saltHex, SECRET_BLOCK: session.secretBlock, SRP_B: session.srpBHex, USERNAME: userId, USER_ID_FOR_SRP: userId },
    };
  }

  private async passwordVerifier(responses: Readonly<Record<string, string>>): Promise<unknown> {
    const secretBlock = responses.PASSWORD_CLAIM_SECRET_BLOCK ?? "";
    const pending = this.pending.get(secretBlock);
    this.pending.delete(secretBlock);
    const user = pending?.username ? this.pool.find(pending.username) : undefined;
    const ok =
      pending !== undefined &&
      user !== undefined &&
      responses.USERNAME === user.username &&
      (await pending.session.verify({ srpAHex: pending.srpA, userId: user.username, timestamp: responses.TIMESTAMP ?? "", secretBlock, signature: responses.PASSWORD_CLAIM_SIGNATURE ?? "" }));
    if (!ok || !user || !user.enabled) throw cognitoFault("NotAuthorizedException", "Incorrect username or password.");
    if (user.status === "UNCONFIRMED") throw cognitoFault("UserNotConfirmedException", "User is not confirmed.");
    const authTime = Math.floor(this.now().getTime() / 1000);
    const refreshToken = this.issuer.opaque("refresh");
    this.refreshTokens.set(refreshToken, { username: user.username, authTime });
    return { AuthenticationResult: { ...(await this.tokens(user, authTime)), RefreshToken: refreshToken } };
  }

  private async refresh(token: string): Promise<unknown> {
    const known = this.refreshTokens.get(token);
    const user = known ? this.pool.find(known.username) : undefined;
    if (!known || !user || this.revoked.has(token)) throw cognitoFault("NotAuthorizedException", "Refresh Token has been revoked");
    return { AuthenticationResult: await this.tokens(user, known.authTime) };
  }

  private async tokens(user: PoolUser, authTime: number): Promise<{ IdToken: string; AccessToken: string; ExpiresIn: number }> {
    const { claims, groups } = await this.preToken(user);
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    const idToken = this.issuer.idToken(
      {
        sub: user.sub,
        auth_time: authTime,
        "cognito:username": user.username,
        ...(user.email ? { email: user.email, email_verified: true } : {}),
        ...(groups.length > 0 ? { "cognito:groups": [...groups] } : {}),
        ...claims,
      },
      nowSeconds,
    );
    const accessToken = this.issuer.opaque("access");
    this.accessTokens.set(accessToken, user.username);
    return { IdToken: idToken, AccessToken: accessToken, ExpiresIn: 900 };
  }

  private async forgot(username: string, metadata: Readonly<Record<string, string>>): Promise<unknown> {
    const user = this.pool.find(username);
    if (!user?.email) return { CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "***" } };
    await this.pool.sendCode(user, "CustomMessage_ForgotPassword", metadata);
    return { CodeDeliveryDetails: { DeliveryMedium: "EMAIL", AttributeName: "email", Destination: "***" } };
  }

  private async confirmForgot(body: Body): Promise<unknown> {
    const user = this.pool.find(body.Username ?? "");
    if (!user?.resetCode || user.resetCode !== body.ConfirmationCode) throw cognitoFault("CodeMismatchException", "Invalid verification code provided, please try again.");
    await this.pool.setPassword(user, body.Password ?? "");
    user.resetCode = undefined;
    return {};
  }
}
