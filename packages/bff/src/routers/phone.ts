// The SMS code of every sign-in session (ADR-0021, docs/tool-catalog.md "Verificación del celular"),
// mounted under `account` (routers/index.ts) on `phoneProcedure`: any verified id token, staff or
// guest, with or without a world, because the session that has not passed the code reaches nothing
// else (phone-gate.ts). Account, session, user name and email come from the token, the viewer's IP
// from CloudFront; nothing of the input names an account.
//
//   phoneStatus      CLEARED | ENROL (+ the sign-up's number) | SIGN_IN (+ the last four digits)
//   sendPhoneCode    `{ phone? }`: a corrected number only while enrolling
//   verifyPhoneCode  `{ code }`
//   endPhoneSession  sign-out: the session's mark goes away
//
// A blocked account (phone-gate.ts) gets 403 `ACCOUNT_BLOCKED` here too, before anything is read or
// sent: only `endPhoneSession` still answers, so the sign-out completes.
import { TRPCError } from "@trpc/server";
import type { Language } from "@legajo/shared";
import { SendPhoneCodeInput, VerifyPhoneCodeInput } from "@legajo/shared/phone-verification";
import { AUTH_REASON, AuthError } from "../auth/errors";
import { viewerIpHash } from "../lib/viewer-ip";
import { signInSessionId } from "../phone-verification/records";
import { type PhoneAccount, endPhoneSession, phoneStatus, sendPhoneCode, verifyPhoneCode } from "../phone-verification/service";
import { assertPhoneCleared } from "./phone-gate";
import { type Context, publicProcedure } from "./trpc";

export interface PhoneContext extends Context {
  readonly phoneAccount: PhoneAccount;
}

async function languageOf(ctx: Context, sub: string, username: string): Promise<Language> {
  const chosen = (await ctx.deps.connector.runtime.getAccountPreferences(sub))?.language;
  if (chosen !== undefined) return chosen;
  return (await ctx.access().leads.getDraft(username, ctx.access().now()))?.language ?? "es";
}

/** A verified id token, whatever its role and world; the session's own phone procedures only. */
export const phoneProcedure = publicProcedure.use(async ({ ctx, next, path }) => {
  const claims = ctx.claims;
  if (claims === null) {
    const cause = ctx.authFailure ?? new AuthError(AUTH_REASON.TOKEN_MISSING, "missing bearer token");
    ctx.log.warn("console.auth.refused", { path, reason: cause.reason });
    throw new TRPCError({ code: "UNAUTHORIZED", message: cause.message, cause });
  }
  const identity = { sub: claims.sub, authTime: claims.auth_time, ...(claims.origin_jti === undefined ? {} : { originJti: claims.origin_jti }) };
  await assertPhoneCleared(ctx, identity, path);
  const username = claims["cognito:username"];
  const viewer = ctx.request.viewer;
  const phoneAccount: PhoneAccount = {
    sub: claims.sub,
    sessionId: signInSessionId(identity),
    username,
    ...(typeof claims.email === "string" && claims.email !== "" ? { email: claims.email } : {}),
    ...(viewer === undefined ? {} : { ipHash: viewerIpHash(ctx.access().keys.rate, viewer) }),
    lang: await languageOf(ctx, claims.sub, username),
  };
  const phoneContext: PhoneContext = { ...ctx, log: ctx.log.child({ sub: claims.sub }), phoneAccount };
  return next({ ctx: phoneContext });
});

export const phoneProcedures = {
  phoneStatus: phoneProcedure.query(({ ctx }) => phoneStatus(ctx.access(), ctx.phoneAccount)),

  sendPhoneCode: phoneProcedure.input(SendPhoneCodeInput).mutation(({ ctx, input }) => sendPhoneCode(ctx.access(), ctx.phoneAccount, input.phone, ctx.log)),

  verifyPhoneCode: phoneProcedure.input(VerifyPhoneCodeInput).mutation(({ ctx, input }) => verifyPhoneCode(ctx.access(), ctx.phoneAccount, input.code, ctx.log)),

  endPhoneSession: phoneProcedure.mutation(async ({ ctx }) => {
    await endPhoneSession(ctx.access(), ctx.phoneAccount);
    return { ended: true };
  }),
};
