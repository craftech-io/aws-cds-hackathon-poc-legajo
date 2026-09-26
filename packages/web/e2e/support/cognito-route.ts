// The Cognito API of the console answered from the page itself (page.route on the user-pool
// endpoint), so the sign-in screens run end to end without AWS: InitiateAuth (SRP and refresh),
// RespondToAuthChallenge, RevokeToken, ChangePassword, AssociateSoftwareToken and the rest of what
// src/lib/auth/cognito.ts calls. Tokens are signed with the run's ephemeral key. Every request body is
// kept so a spec can assert what left the browser (never the password, on the SRP path).
import type { Page } from "@playwright/test";
import { COGNITO_ENDPOINT } from "./env";
import { type PersonaName, PERSONAS, idTokenFor } from "./session";

export interface CognitoCall {
  readonly operation: string;
  readonly body: string;
}

export interface CognitoAnswer {
  readonly status?: number;
  readonly body: unknown;
}

export type CognitoScript = Readonly<Record<string, CognitoAnswer | ((call: CognitoCall) => CognitoAnswer)>>;

/** A PASSWORD_VERIFIER challenge with well-formed SRP parameters (their values are irrelevant here). */
export function passwordVerifier(name: PersonaName): CognitoAnswer {
  const { sub } = PERSONAS[name];
  return {
    body: {
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: {
        SALT: "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d",
        SECRET_BLOCK: "c2VjcmV0LWJsb2NrLW9mLXRoZS1lMmUtZmFrZQ==",
        SRP_B: "5a7c".repeat(96),
        USERNAME: sub,
        USER_ID_FOR_SRP: sub,
      },
    },
  };
}

export function tokensAnswer(name: PersonaName, refreshToken: string | null = `e2e-refresh-${name}`): CognitoAnswer {
  return {
    body: {
      AuthenticationResult: {
        IdToken: idTokenFor(name),
        AccessToken: `e2e-access-${name}`,
        ...(refreshToken !== null ? { RefreshToken: refreshToken } : {}),
        ExpiresIn: 900,
      },
    },
  };
}

export function challengeAnswer(challengeName: string, name: PersonaName, parameters: Record<string, string> = {}): CognitoAnswer {
  return { body: { ChallengeName: challengeName, Session: `e2e-session-${challengeName}`, ChallengeParameters: { USER_ID_FOR_SRP: PERSONAS[name].sub, ...parameters } } };
}

export function cognitoError(type: string, message = type): CognitoAnswer {
  return { status: 400, body: { __type: type, message } };
}

/** The challenge a RespondToAuthChallenge call answers (`PASSWORD_VERIFIER`, `SOFTWARE_TOKEN_MFA`, …). */
export function challengeOf(call: CognitoCall): string | undefined {
  const parsed = JSON.parse(call.body || "{}") as { ChallengeName?: unknown };
  return typeof parsed.ChallengeName === "string" ? parsed.ChallengeName : undefined;
}

/** Routes the Cognito endpoint to `script`; an unscripted operation answers 400, loudly. */
export async function routeCognito(page: Page, script: CognitoScript = {}): Promise<CognitoCall[]> {
  const calls: CognitoCall[] = [];
  await page.route(COGNITO_ENDPOINT, async (route) => {
    const request = route.request();
    const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "POST" };
    if (request.method() === "OPTIONS") {
      await route.fulfill({ status: 200, headers: cors });
      return;
    }
    const operation = (request.headers()["x-amz-target"] ?? "").split(".")[1] ?? "";
    const call = { operation, body: request.postData() ?? "" };
    calls.push(call);
    const entry = script[operation];
    const answer = typeof entry === "function" ? entry(call) : (entry ?? cognitoError("UnscriptedOperation", operation));
    await route.fulfill({ status: answer.status ?? 200, headers: { ...cors, "content-type": "application/x-amz-json-1.1" }, body: JSON.stringify(answer.body) });
  });
  return calls;
}
