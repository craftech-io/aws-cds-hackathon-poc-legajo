// Root router of the console: one key per feature (docs/tool-catalog.md "Procedimientos de la
// consola"), each built from the procedures of ./trpc, plus the public health probe the interim
// smoke and `SC-00` call (`GET /api/health`). The web client is typed against `AppRouter`; WP-33
// registers the feature routers here.
import { healthReport } from "./health";
import { type Context, createCallerFactory, publicProcedure, router } from "./trpc";

export const appRouter = router({
  /** No principal, no data: the function answers, and so do the mocks it calls with its role. */
  health: publicProcedure.query(({ ctx }) => healthReport(ctx.deps.health, ctx.log)),
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
