// `signup` router (ADR-0015 §1 to §3; docs/tool-catalog.md "Alta pública e invitados"): the public
// sign-up, without a token, behind WAF, OAC and the origin check of handler.ts. `signupProcedure`
// accepts a call only on its exact route, alone and without `batch` (the second, independent check of
// what handler.ts refuses), and only with the viewer's IP, which every rate limit keys by its hash.
// Nothing here writes `AuditLog` or logs an email: the metrics count by reason (signup/service.ts).
import { TRPCError } from "@trpc/server";
import { ToolError } from "@legajo/shared";
import { SignupConfirmInput, SignupFormInput, SignupResendInput, SignupStartInput } from "@legajo/shared/signup";
import { countMetric } from "../channels/adapter";
import { viewerIpHash } from "../lib/viewer-ip";
import { SIGNUP_METRICS } from "../signup/dispatch";
import { SIGNUP_PREFIX } from "../signup/edge";
import { signupConfirm, signupForm, signupResend, signupStart } from "../signup/service";
import { type Context, IN_PROCESS, publicProcedure, router } from "./trpc";

export interface SignupContext extends Context {
  /** HMAC of the viewer's aggregated IP with the `rate` subkey (lib/viewer-ip.ts); never the IP. */
  readonly ipHash: string;
}

function invalid(message: string, reason: "BATCH_NOT_ALLOWED" | "NO_VIEWER_IP"): TRPCError {
  return new TRPCError({ code: "BAD_REQUEST", message, cause: new ToolError("INVALID", message, reason) });
}

export const signupProcedure = publicProcedure.use(({ ctx, next, path }) => {
  const { request } = ctx;
  const alone = request === IN_PROCESS || (!request.batch && !request.encoded && request.procedures.length === 1 && request.procedures[0] === path);
  if (!alone || !path.startsWith(SIGNUP_PREFIX)) throw invalid("a sign-up is one request on its own route", "BATCH_NOT_ALLOWED");
  if (request.viewer === undefined) {
    countMetric(ctx.log, SIGNUP_METRICS.rejected, { reason: "NO_VIEWER_IP" });
    throw invalid("the request carries no viewer address", "NO_VIEWER_IP");
  }
  const signupContext: SignupContext = { ...ctx, ipHash: viewerIpHash(ctx.access().keys.rate, request.viewer) };
  return next({ ctx: signupContext });
});

export const signupRouter = router({
  form: signupProcedure.input(SignupFormInput).query(({ ctx, input }) => signupForm(ctx.access(), input.lang)),
  start: signupProcedure.input(SignupStartInput).mutation(({ ctx, input }) => signupStart(ctx.access(), input, { ipHash: ctx.ipHash, log: ctx.log })),
  resend: signupProcedure.input(SignupResendInput).mutation(({ ctx, input }) => signupResend(ctx.access(), input.signupId, { ipHash: ctx.ipHash, log: ctx.log })),
  confirm: signupProcedure.input(SignupConfirmInput).mutation(({ ctx, input }) => signupConfirm(ctx.access(), input, { ipHash: ctx.ipHash, log: ctx.log })),
});
