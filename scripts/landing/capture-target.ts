// Where the landing's captures may be taken (ADR-0016 §4, FL-129): the deployed stage at
// https://legajo.demo.craftech.io (or one of its subdomains), over HTTPS, with nothing else in the
// address; or the local UI server on 127.0.0.1. Any other `--base-url` is refused before a browser
// starts. While capturing, every request outside the target is aborted and fails the run: on the
// stage only the app's origin, Cognito's endpoint of its region and the pre-signed S3 reads of the
// console go through.
import { parseArgs } from "node:util";

export const STAGE_URL = "https://legajo.demo.craftech.io";
const STAGE_HOST = new URL(STAGE_URL).hostname;
export const STAGE_REGION = "us-east-1";

/** The origin of an allowed `--base-url`, or an error that says why it is refused. */
export function parseBaseUrl(value: string | undefined): string {
  if (value === undefined) return STAGE_URL;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("--base-url is not a URL");
  }
  const onStage = url.hostname === STAGE_HOST || url.hostname.endsWith(`.${STAGE_HOST}`);
  if (url.protocol !== "https:" || !onStage) throw new Error(`--base-url must be ${STAGE_URL} or one of its subdomains, over https`);
  if (url.port !== "" || url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new Error("--base-url takes only the origin: no port, credentials, path, query or anchor");
  }
  return url.origin;
}

/** Requests a capture of the stage may make: the app itself, Cognito of the region and S3's pre-signed reads. */
export function stageRequestAllowed(base: string, region: string = STAGE_REGION): (url: URL) => boolean {
  const s3 = new RegExp(`^[a-z0-9.-]+\\.s3(?:\\.${region})?\\.amazonaws\\.com$`);
  return (url) => url.origin === base || (url.protocol === "https:" && (url.hostname === `cognito-idp.${region}.amazonaws.com` || s3.test(url.hostname)));
}

/** Requests a local capture may make: the local server's origin only. */
export function localRequestAllowed(origin: string): (url: URL) => boolean {
  return (url) => url.origin === origin;
}

export interface CaptureOptions {
  readonly target: "poc" | "local";
  readonly baseUrl: string;
  readonly only: ReadonlySet<string> | undefined;
  /** Write the pictures here and leave public/ and the manifest untouched. */
  readonly out: string | undefined;
}

export function parseCaptureArgs(argv: readonly string[]): CaptureOptions {
  const { values } = parseArgs({ args: [...argv], options: { target: { type: "string" }, "base-url": { type: "string" }, only: { type: "string" }, out: { type: "string" } } });
  if (values.target !== "poc" && values.target !== "local") throw new Error("--target poc|local is required");
  if (values.target === "local" && values["base-url"] !== undefined) throw new Error("--base-url applies to --target poc only");
  return {
    target: values.target,
    baseUrl: parseBaseUrl(values["base-url"]),
    only: values.only ? new Set(values.only.split(",").map((id) => id.trim())) : undefined,
    out: values.out,
  };
}
