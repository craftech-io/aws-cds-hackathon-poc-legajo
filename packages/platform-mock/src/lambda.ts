// Function URL adapter of the platform mock: validates the event AWS delivers (zod, like every edge),
// decodes the body, runs the app and shapes the result. The dependencies are resolved on the first
// request and kept for the container; if they cannot be resolved (a resource not linked) every
// request answers 503, `/v1/health` included, and the next request tries again.
import { z } from "zod";
import { createPlatformApp, type PlatformApp, type PlatformAppDeps } from "./app";
import { PlatformHttpError, RETRY_AFTER_SECONDS, errorResponse, type PlatformResponse } from "./http";
import { correlationIdOf, stdoutSink, type PlatformLogSink } from "./log";

/** The part of a Function URL event (payload 2.0) the mock reads; AWS's other keys are dropped. */
export const FunctionUrlEvent = z.object({
  rawPath: z.string().startsWith("/"),
  rawQueryString: z.string().default(""),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().optional(),
  isBase64Encoded: z.boolean().default(false),
  requestContext: z.object({
    requestId: z.string().optional(),
    http: z.object({ method: z.string().min(1) }),
  }),
});
export type FunctionUrlEvent = z.input<typeof FunctionUrlEvent>;

export interface FunctionUrlResult {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type FunctionUrlHandler = (event: unknown) => Promise<FunctionUrlResult>;

function toResult(response: PlatformResponse): FunctionUrlResult {
  return { statusCode: response.status, headers: response.headers, body: response.body };
}

export interface FunctionUrlHandlerOptions {
  /** Where the adapter logs when it cannot build the app (the app logs everything else). */
  readonly log?: PlatformLogSink;
  readonly now?: () => Date;
}

export function createFunctionUrlHandler(resolveDeps: () => PlatformAppDeps, options: FunctionUrlHandlerOptions = {}): FunctionUrlHandler {
  const log = options.log ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  let app: PlatformApp | undefined;

  return async (raw) => {
    const parsed = FunctionUrlEvent.safeParse(raw);
    if (!parsed.success) return toResult(errorResponse(new PlatformHttpError("INVALID_REQUEST", "unexpected event shape")));
    const event = parsed.data;
    if (app === undefined) {
      try {
        app = createPlatformApp(resolveDeps());
      } catch (error) {
        log({
          level: "error",
          time: now().toISOString(),
          correlationId: correlationIdOf(event.requestContext.requestId),
          message: "platform dependencies unavailable",
          status: 503,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        const unavailable = new PlatformHttpError("UNAVAILABLE", "the platform is not configured", undefined, { "retry-after": String(RETRY_AFTER_SECONDS) });
        return toResult(errorResponse(unavailable));
      }
    }
    const body = event.body === undefined ? undefined : event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    const response = await app.handle({
      method: event.requestContext.http.method,
      url: event.rawQueryString === "" ? event.rawPath : `${event.rawPath}?${event.rawQueryString}`,
      headers: event.headers,
      ...(body === undefined ? {} : { body }),
      ...(event.requestContext.requestId === undefined ? {} : { requestId: event.requestContext.requestId }),
    });
    return toResult(response);
  };
}
