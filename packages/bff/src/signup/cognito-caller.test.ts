// The Cognito calls of `SignupDispatch` carry `x-legajo-caller`, which the rate rules of the user pool's
// web ACL leave out (infra/auth-waf-spec.ts). The request is stopped before it leaves the process.
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { describe, expect, it } from "vitest";
import { COGNITO_CALLER_HEADER } from "../lib/crypto";
import { createSignupCognito } from "./cognito";

function capturingClient(): { client: CognitoIdentityProviderClient; headers: () => Record<string, string> | undefined } {
  const client = new CognitoIdentityProviderClient({ region: "us-east-1", credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "not-a-secret" } });
  let seen: Record<string, string> | undefined;
  client.middlewareStack.add(
    () => async (args) => {
      seen = { ...(args.request as { headers: Record<string, string> }).headers };
      throw Object.assign(new Error("stopped before sending"), { name: "StoppedForTest" });
    },
    { step: "build", priority: "low", name: "captureForTest" },
  );
  return { client, headers: () => seen };
}

const CONFIG = { userPoolId: "us-east-1_TEST", clientId: "client-test", region: "us-east-1" };

describe("[FL-113] x-legajo-caller", () => {
  it("goes on ForgotPassword and ResendConfirmationCode when the client has a caller tag", async () => {
    for (const call of ["forgotPassword", "resendCode"] as const) {
      const { client, headers } = capturingClient();
      const cognito = createSignupCognito({ ...CONFIG, callerTag: "tag-from-the-cognito-caller-subkey-0123456789" }, client);
      await expect(cognito[call]("usr-1", { lang: "es" })).rejects.toThrow("stopped before sending");
      expect(headers()?.[COGNITO_CALLER_HEADER], call).toBe("tag-from-the-cognito-caller-subkey-0123456789");
      expect(headers()?.["x-amz-target"], call).toMatch(call === "forgotPassword" ? /ForgotPassword$/ : /ResendConfirmationCode$/);
    }
  });

  it("is absent without a caller tag", async () => {
    const { client, headers } = capturingClient();
    await expect(createSignupCognito(CONFIG, client).forgotPassword("usr-1", {})).rejects.toThrow("stopped before sending");
    expect(headers()?.[COGNITO_CALLER_HEADER]).toBeUndefined();
  });
});
