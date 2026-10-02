// The local user pool runs the real Cognito triggers of packages/bff/src/auth-triggers (docs/test-plan.md
// §2): `AuthPreSignUp` checks the sign-up ticket `SignupDispatch` put in `ValidationData`,
// `AuthCustomMessage` writes every account email in the user's language (and may refuse to, by quota or
// bounce), and `AuthPreToken` stamps tenant, role, guest flag and world lease from the broker rows of the
// in-memory world. Each is called with the event Cognito would send; nothing is reimplemented here.
import { z } from "zod";
import type { MemoryStores } from "@legajo/bff/connector/index";
import { brokerLookupOf } from "@legajo/bff/auth/staff";
import { createCustomMessageHandler } from "@legajo/bff/auth-triggers/custom-message";
import { createPreSignUpHandler } from "@legajo/bff/auth-triggers/pre-signup";
import { decidePreToken, guestRowsOf } from "@legajo/bff/auth-triggers/pre-token";
import { createLogger } from "@legajo/bff/lib/log";
import type { SignupKeys } from "@legajo/bff/signup/deps";
import type { PreTokenClaims } from "./browser-api";
import type { PoolTriggers, PoolUser } from "./user-pool";

/** Cognito's placeholder of the code: the trigger writes it, the pool puts the code in its place. */
const CODE_PLACEHOLDER = "{####}";

const MessageResponse = z.looseObject({ response: z.looseObject({ emailSubject: z.string(), emailMessage: z.string() }) });

/** `AuthPreSignUp` and `AuthCustomMessage` with this server's keys and its in-memory `Runtime`. */
export function realPoolTriggers(stores: MemoryStores, keys: SignupKeys, now: () => Date): PoolTriggers {
  const preSignUp = createPreSignUpHandler(() => ({ ticketKey: () => keys.ticket, leadEmailKey: () => keys.leadEmail, now, log }));
  const customMessage = createCustomMessageHandler(() => ({ client: stores.client, leadEmailKey: () => keys.leadEmail, rateKey: () => keys.rate, now, log }));
  return {
    async preSignUp(user, validationData) {
      await preSignUp({ triggerSource: "PreSignUp_SignUp", userName: user.username, request: { userAttributes: { email: user.email }, validationData: { ...validationData } } });
    },
    async customMessage(request) {
      const answer = await customMessage({
        triggerSource: request.triggerSource,
        userName: request.user.username,
        request: {
          userAttributes: { sub: request.user.sub, locale: request.user.locale, ...(request.user.email ? { email: request.user.email } : {}) },
          codeParameter: CODE_PLACEHOLDER,
          usernameParameter: request.user.username,
          clientMetadata: { ...request.clientMetadata },
        },
      });
      const { response } = MessageResponse.parse(answer);
      return { subject: response.emailSubject, body: response.emailMessage };
    },
  };
}

const log = createLogger({ level: "warn", bindings: { service: "ui-server-cognito" } });

/** `AuthPreToken` over the in-memory world: what the id token of `user` carries now. */
export function realPreToken(stores: MemoryStores, poolId: string): PreTokenClaims {
  const brokers = brokerLookupOf(stores.connector.firms);
  const guestRows = guestRowsOf(stores.client);
  return async (user: PoolUser) => {
    const decision = await decidePreToken(
      {
        version: "2",
        triggerSource: "TokenGeneration_Authentication",
        userPoolId: poolId,
        userName: user.username,
        request: {
          userAttributes: { sub: user.sub, ...(user.email ? { email: user.email } : {}), ...(user.firmId ? { "custom:firmId": user.firmId } : {}) },
          groupConfiguration: { groupsToOverride: [...user.groups] },
        },
      },
      { brokers, guestRows, log },
    );
    const details = decision.details;
    const suppressed = new Set(details.idTokenGeneration.claimsToSuppress ?? []);
    const claims = Object.fromEntries(
      Object.entries({ ...(user.firmId ? { "custom:firmId": user.firmId } : {}), ...(details.idTokenGeneration.claimsToAddOrOverride ?? {}) }).filter(([name]) => !suppressed.has(name)),
    );
    return { claims, groups: details.groupOverrideDetails.groupsToOverride ?? [...user.groups] };
  };
}
