// Local stand-in for the S3 endpoints the browser talks to in the UI tests (docs/test-plan.md §2,
// level UI): the pre-signed POST of the upload page and of the phone simulator, and the pre-signed
// GET of a document download. A POST is accepted only as S3 would: a policy signed with SigV4 by the
// emulator's own credentials, not expired, whose every condition holds, in particular the exact key,
// `Content-Type application/pdf` and `content-length-range`. Objects live in memory for the run.
import { createHmac } from "node:crypto";

/** Credentials of the local S3 client; they sign nothing outside this process. */
export const EMULATOR_CREDENTIALS = { accessKeyId: "LOCALEMULATORKEY", secretAccessKey: "local-emulator-secret" } as const;
export const EMULATOR_REGION = "us-east-1";

export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly contentType: string;
  readonly body: Uint8Array;
}

export type PostVerdict = { readonly ok: true; readonly object: StoredObject } | { readonly ok: false; readonly status: number; readonly code: string };

type Condition = Readonly<Record<string, string>> | readonly [string, ...unknown[]];

interface Policy {
  readonly expiration: string;
  readonly conditions: readonly Condition[];
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** SigV4 signature of a POST policy: HMAC of the base64 policy with the key of date, region and service. */
export function policySignature(secretAccessKey: string, date: string, region: string, base64Policy: string): string {
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date), region), "s3"), "aws4_request");
  return createHmac("sha256", signingKey).update(base64Policy).digest("hex");
}

function field(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

function conditionHolds(condition: Condition, form: FormData, bucket: string, size: number): boolean {
  if (!Array.isArray(condition)) {
    return Object.entries(condition).every(([name, expected]) => (name === "bucket" ? bucket === expected : field(form, name) === expected));
  }
  const [operator, first, second] = condition;
  if (operator === "content-length-range") return typeof first === "number" && typeof second === "number" && size >= first && size <= second;
  const name = typeof first === "string" ? first.replace(/^\$/, "") : "";
  const actual = name === "bucket" ? bucket : field(form, name);
  if (operator === "eq") return actual === second;
  if (operator === "starts-with") return typeof second === "string" && actual !== undefined && actual.startsWith(second);
  return false;
}

function parsePolicy(base64: string): Policy | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { expiration, conditions } = parsed as Record<string, unknown>;
    return typeof expiration === "string" && Array.isArray(conditions) ? { expiration, conditions: conditions as Condition[] } : undefined;
  } catch {
    return undefined;
  }
}

/** Checks one pre-signed POST the way S3 does; `now` is real time. */
export async function verifyPost(form: FormData, bucket: string, now: Date): Promise<PostVerdict> {
  const base64Policy = field(form, "Policy");
  const credential = field(form, "X-Amz-Credential");
  const signature = field(form, "X-Amz-Signature");
  const file = form.get("file");
  if (base64Policy === undefined || credential === undefined || signature === undefined || !(file instanceof Blob)) return { ok: false, status: 400, code: "InvalidRequest" };
  const [accessKeyId, date = "", region = ""] = credential.split("/");
  if (accessKeyId !== EMULATOR_CREDENTIALS.accessKeyId || policySignature(EMULATOR_CREDENTIALS.secretAccessKey, date, region, base64Policy) !== signature) {
    return { ok: false, status: 403, code: "SignatureDoesNotMatch" };
  }
  const policy = parsePolicy(base64Policy);
  if (policy === undefined) return { ok: false, status: 400, code: "InvalidPolicyDocument" };
  if (Date.parse(policy.expiration) <= now.getTime()) return { ok: false, status: 403, code: "AccessDenied" };
  const body = new Uint8Array(await file.arrayBuffer());
  const failed = policy.conditions.find((condition) => !conditionHolds(condition, form, bucket, body.byteLength));
  if (failed !== undefined) {
    const tooBig = Array.isArray(failed) && failed[0] === "content-length-range";
    return { ok: false, status: tooBig ? 400 : 403, code: tooBig ? "EntityTooLarge" : "AccessDenied" };
  }
  // Every form field must be named by a condition, as S3 requires (the signature fields excepted).
  const unsigned = [...form.keys()].filter((name) => !["file", "Policy", "X-Amz-Signature"].includes(name) && !policy.conditions.some((condition) => (Array.isArray(condition) ? String(condition[1]).replace(/^\$/, "") === name : name in condition)));
  if (unsigned.length > 0) return { ok: false, status: 403, code: "AccessDenied" };
  const key = field(form, "key") ?? "";
  return { ok: true, object: { bucket, key, contentType: field(form, "Content-Type") ?? "", body } };
}

/** The emulator's store: objects by bucket and key. */
export class ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  put(object: StoredObject): void {
    this.objects.set(`${object.bucket}/${object.key}`, object);
  }

  get(bucket: string, key: string): StoredObject | undefined {
    return this.objects.get(`${bucket}/${key}`);
  }

  keys(bucket: string): string[] {
    return [...this.objects.values()].filter((object) => object.bucket === bucket).map((object) => object.key);
  }
}
