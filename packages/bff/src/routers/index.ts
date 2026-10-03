// Root router of the console: one key per feature (docs/tool-catalog.md "Procedimientos de la
// consola"), each built from the procedures of ./trpc, plus the public health probe the interim
// smoke and `SC-00` call (`GET /api/health`) and the public sign-up. The web client is typed against
// `AppRouter`.
import { accountRouter } from "./account";
import { activityRouter } from "./activity";
import { auditRouter } from "./audit";
import { clockRouter } from "./clock";
import { conversationRouter } from "./conversation";
import { dossierRouter } from "./dossier";
import { escalationsRouter } from "./escalations";
import { guestWorldProcedures } from "./guest-world";
import { healthReport } from "./health";
import { mailboxRouter } from "./mailbox";
import { metricsRouter } from "./metrics";
import { operationsRouter } from "./operations";
import { registryRouter } from "./registry";
import { signupRouter } from "./signup";
import { simulatorRouter } from "./simulator";
import { tourRouter } from "./tour";
import { type Context, createCallerFactory, mergeRouters, publicProcedure, router } from "./trpc";

export const appRouter = router({
  /** No principal, no data: the function answers, and so do the mocks it calls with its role. */
  health: publicProcedure.query(({ ctx }) => healthReport(ctx.deps.health, ctx.log)),
  /** `session` and `usage` (account.ts), `ensureWorld` and `world` of a guest's world (guest-world.ts, WP-31). */
  account: mergeRouters(accountRouter, router(guestWorldProcedures)),
  activity: activityRouter,
  audit: auditRouter,
  clock: clockRouter,
  conversation: conversationRouter,
  dossier: dossierRouter,
  escalations: escalationsRouter,
  mailbox: mailboxRouter,
  metrics: metricsRouter,
  operations: operationsRouter,
  registry: registryRouter,
  simulator: simulatorRouter,
  /** The guided tour of a guest over operation 4471 (the steps live in packages/web/src/views/tour/steps.ts). */
  tour: tourRouter,
  /** The public sign-up (ADR-0015 §1): no token, one procedure per request, never in a batch. */
  signup: signupRouter,
});

export type AppRouter = typeof appRouter;

const createAppCaller = createCallerFactory(appRouter);

/**
 * The console procedures in process, for the `QaDriver`'s `console.*` actions: pass a
 * `serverContext` with a principal built on the server and every middleware (firm fence, role,
 * recent login) runs as it does behind the Router.
 */
export function createConsoleCaller(context: Context) {
  return createAppCaller(context);
}
