// Infra of the public signup and the leads as plain data and pure functions (ADR-0015 §1, §3, §5 and
// §6, docs/architecture.md §3, §5 and §14, docs/build-plan.md WP-51). No SST or Pulumi dependency:
// infra/leads.ts builds the resources from this file, and infra/leads-spec.test.ts and
// infra/iam-leads.test.ts check every value against the docs and iam-capabilities.ts.
//
// `Leads` holds real addresses, so no Lambda links the table whole (an SST link grants `dynamodb:*`):
// the code reads `Resource.Leads.name` from a Linkable without permissions and each role of the
// closed list (Bff, SignupDispatch, WorldJanitor, LeadNotice and the fenced QaDriver; ADR-0015 §6)
// gets its own statement, `LEADS_ACCESS`. Where IAM can fence by key (`dynamodb:LeadingKeys`), it
// does: SignupDispatch touches only `SIGNUP#`, LeadNotice only `EMAIL#`. WorldJanitor sweeps and
// enforces retention by Scan, where a leading-key condition has nothing to compare, and the QaDriver's
// fence is its own `qa-signup-<runId>-*` mailboxes, an HMAC IAM cannot see: both stay fenced in code.

import { CI_DEPLOY_STAGE } from "./ci-spec";
import { LAMBDA_CAPABILITIES, expectedActions, resolveCapabilities, type BucketName, type LambdaName } from "./iam-capabilities";
import { QA_PREFIX, inboundMailRoutes, type KeyFencedRole } from "./storage-keys";

/** `Resource.Leads.name`: the name-only Linkable of the table (component `LeadsData`, storage-tables.ts). */
export const LEADS_LINK = "Leads";

/** Roles that reach `Leads` (ADR-0015 §6): the closed list. The operator's scripts use their own credentials. */
export const LEADS_ROLES = ["Bff", "SignupDispatch", "WorldJanitor", "LeadNotice", "QaDriver"] as const satisfies readonly LambdaName[];
export type LeadsRole = (typeof LEADS_ROLES)[number];

export interface LeadsAccess {
  readonly actions: readonly string[];
  /** `ForAllValues:StringLike dynamodb:LeadingKeys`; omitted where the role's reads have no leading key. */
  readonly leadingKeys?: readonly string[];
}

export const LEADS_ACCESS: Readonly<Record<LeadsRole, LeadsAccess>> = {
  // signup.* writes and reads SIGNUP#; finalizeSignup writes the lead (conditional) and deletes
  // SIGNUP#; account.session raises lastLoginAt. Never DELETED#.
  Bff: {
    actions: ["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:UpdateItem"],
    leadingKeys: ["EMAIL#*", "SIGNUP#*"],
  },
  // Only its own SIGNUP# (dispatchSeq, branch, REMOVE passwordSealed); never writes a lead (§1.4).
  SignupDispatch: { actions: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:UpdateItem"], leadingKeys: ["SIGNUP#*"] },
  // GUEST_SWEEP finalizes verified signups, retries notices and deletes leads after 24 months with a
  // DELETED# tombstone; GUEST_DESTROY of leads:delete. Scan finds them: no leading key to fence.
  WorldJanitor: {
    actions: ["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query", "dynamodb:Scan", "dynamodb:UpdateItem"],
  },
  // Reads the lead and writes noticeStatus.
  LeadNotice: { actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], leadingKeys: ["EMAIL#*"] },
  // lead.inspect and lead.purge of SC-26 (docs/test-plan.md §4.1), only its qa-signup-<runId>-* leads.
  QaDriver: { actions: ["dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"] },
};

/** Writes that create a lead item; only finalizeSignup (Bff), the sweep (WorldJanitor) and SC-26's cleanup may. */
export const LEAD_WRITE_ACTIONS = ["dynamodb:PutItem", "dynamodb:BatchWriteItem"] as const;

export interface IamCondition {
  readonly test: string;
  readonly variable: string;
  readonly values: string[];
}

/** `R` is a plain ARN in tests and an Output of one in infra/leads.ts. */
export interface IamStatement<R = string> {
  readonly actions: string[];
  readonly resources: R[];
  readonly conditions?: IamCondition[];
}

/** The statement of one role on `Leads` (the table has no index). */
export function leadsStatement<R>(fn: LeadsRole, tableArn: R): IamStatement<R> {
  const access = LEADS_ACCESS[fn];
  return {
    actions: [...access.actions],
    resources: [tableArn],
    ...(access.leadingKeys === undefined ? {} : { conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...access.leadingKeys] }] }),
  };
}

/** The Cognito actions of a role (docs/architecture.md §14), all on the app's pool ARN. */
export function cognitoActions(fn: LambdaName): string[] {
  return expectedActions(fn).filter((action) => action.startsWith("cognito-idp:"));
}

export function cognitoStatement<R>(fn: LambdaName, poolArn: R): IamStatement<R> | undefined {
  const actions = cognitoActions(fn);
  return actions.length === 0 ? undefined : { actions, resources: [poolArn] };
}

// ---- Runtime keys of the signup (ADR-0015 §3.2 and §4) -------------------------------------------

/**
 * `Runtime` items the BFF writes for the signup and the guest worlds: rate limits (`RL#`), quotas per
 * world (`QUOTA#`), guest slots (`SLOT#`) and the lease per account (`GUESTWORLD#`).
 */
export const SIGNUP_RUNTIME_KEYS = ["RL#*", "QUOTA#*", "SLOT#*", "GUESTWORLD#*"] as const;
export const SIGNUP_RUNTIME_ACTIONS = ["dynamodb:ConditionCheckItem", "dynamodb:DeleteItem", "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"] as const;

export function signupRuntimeStatement<R>(runtimeArn: R): IamStatement<R> {
  return {
    actions: [...SIGNUP_RUNTIME_ACTIONS],
    resources: [runtimeArn],
    conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...SIGNUP_RUNTIME_KEYS] }],
  };
}

/** `Resource.RuntimeKeys.name`: `Runtime`'s name without permissions, for the key-fenced roles (storage-keys.ts). */
export const RUNTIME_KEYS_LINK = "RuntimeKeys";

/**
 * What the key-fenced roles may do on `Runtime` instead of linking it whole (`dynamodb:*`):
 * SignupDispatch reads the bounce state and the breaker and counts the sign-ups per mailbox and domain
 * (`RL#START#`); AuthCustomMessage reads the same two and counts the account emails (`RL#MAIL#`).
 */
export const RUNTIME_KEY_FENCES: Readonly<Record<KeyFencedRole, LeadsAccess>> = {
  SignupDispatch: { actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], leadingKeys: ["MAILSTATUS#*", "MAILBREAKER", "RL#START#*"] },
  AuthCustomMessage: { actions: ["dynamodb:GetItem", "dynamodb:UpdateItem"], leadingKeys: ["MAILSTATUS#*", "MAILBREAKER", "RL#MAIL#*"] },
};

export function runtimeKeysStatement<R>(fn: KeyFencedRole, runtimeArn: R): IamStatement<R> {
  const fence = RUNTIME_KEY_FENCES[fn];
  return {
    actions: [...fence.actions],
    resources: [runtimeArn],
    conditions: [{ test: "ForAllValues:StringLike", variable: "dynamodb:LeadingKeys", values: [...(fence.leadingKeys ?? [])] }],
  };
}

// ---- S3 of guest worlds (WorldJanitor) and of SC-26 (QaDriver) ---------------------------------------

export type GuestObjectBucket = Extract<BucketName, "Documents" | "Media" | "Uploads" | "InboundMail">;

/**
 * What `destroyWorld` of a guest world deletes (ADR-0015 §4, docs/architecture.md §14): the world's
 * prefix in Documents and Media, its links' uploads and the raw MIME its messages cite. The code
 * deletes only the keys of the world it destroys (packages/bff/src/worlds, test in guest-worlds.test.ts).
 */
export const GUEST_OBJECT_PREFIXES: Readonly<Record<GuestObjectBucket, readonly string[]>> = {
  Documents: ["guest/"],
  Media: ["guest/"],
  Uploads: ["uploads/"],
  InboundMail: inboundMailRoutes(CI_DEPLOY_STAGE).map((route) => route.prefix),
};

/** DeleteObject under the bucket's guest prefixes and ListBucket of the bucket only for those prefixes. */
export function guestObjectStatementsFor(bucket: GuestObjectBucket, bucketName: string): IamStatement[] {
  const prefixes = GUEST_OBJECT_PREFIXES[bucket];
  return [
    { actions: ["s3:DeleteObject"], resources: prefixes.map((prefix) => `arn:aws:s3:::${bucketName}/${prefix}*`) },
    { actions: ["s3:ListBucket"], resources: [`arn:aws:s3:::${bucketName}`], conditions: [{ test: "StringLike", variable: "s3:prefix", values: prefixes.map((prefix) => `${prefix}*`) }] },
  ];
}

/** Every statement of the guest world's objects, for the four buckets. */
export function guestObjectStatements(bucketNames: Readonly<Record<GuestObjectBucket, string>>): IamStatement[] {
  return (Object.keys(GUEST_OBJECT_PREFIXES) as GuestObjectBucket[]).flatMap((bucket) => guestObjectStatementsFor(bucket, bucketNames[bucket]));
}

/** Every epoch of the guest-test world (`guest/res/firm-guest-test/e<n>/`, packages/shared/src/document-keys.ts). */
export const GUEST_TEST_OBJECT_PREFIX = "guest/res/firm-guest-test/";

/**
 * What the QaDriver's `world.destroy` deletes (`QaWorldObjects`, infra/leads.ts): `qa/<runId>/` of a QA
 * run and the guest-test world's prefix in Documents and Media, `qa/` in Uploads. Never `guest/` of another
 * world, never `uploads/<token>/` and never the mail bucket: those of a QA or guest-test world expire by
 * lifecycle (Uploads 1 day, mail 30 days). The role reaches Documents, Uploads and Media through their bucket
 * links (`s3:*`, storage.ts `storageLinks`), so this list is the code's fence there (worlds/objects.ts);
 * the mail bucket it only reads (`poc/ops/`, `poc/sim/`), with no DeleteObject at all.
 */
export const QA_WORLD_OBJECT_PREFIXES: Readonly<Record<Exclude<GuestObjectBucket, "InboundMail">, readonly string[]>> = {
  Documents: [QA_PREFIX, GUEST_TEST_OBJECT_PREFIX],
  Media: [QA_PREFIX, GUEST_TEST_OBJECT_PREFIX],
  Uploads: [QA_PREFIX],
};

/** SC-26's `signup.readCode`: the codes land in the simulated mailboxes, `poc/sim/` of the mail bucket. */
export const QA_SIGNUP_MAIL_PREFIX = inboundMailRoutes(CI_DEPLOY_STAGE).find((route) => route.rule === `sim-${CI_DEPLOY_STAGE}`)?.prefix ?? "";

export function qaSignupMailStatements(mailBucket: string): IamStatement[] {
  return [
    { actions: ["s3:GetObject"], resources: [`arn:aws:s3:::${mailBucket}/${QA_SIGNUP_MAIL_PREFIX}*`] },
    { actions: ["s3:ListBucket"], resources: [`arn:aws:s3:::${mailBucket}`], conditions: [{ test: "StringLike", variable: "s3:prefix", values: [`${QA_SIGNUP_MAIL_PREFIX}*`] }] },
  ];
}

// ---- Functions -----------------------------------------------------------------------------------------

export type LeadsFunction = "SignupDispatch" | "LeadNotice";

/**
 * `handler`: WP-50's file. `retries`: asynchronous retries of Lambda. SignupDispatch has none
 * (ADR-0015 §1.1: a failure leaves `branch = FAILED` and the visitor asks to resend); LeadNotice has
 * none either: a failed send stays `PENDING` and GUEST_SWEEP retries it, so a Lambda retry never
 * sends a second notice for the same lead. `reservedConcurrency`: docs/architecture.md §12.
 */
export interface LeadsFunctionSpec {
  readonly handler: string;
  readonly description: string;
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
  readonly reservedConcurrency: number;
  readonly retries: number;
  /** Lambdas whose role may invoke it (resource policy), from the capability that grants it. */
  readonly invokedBy: readonly LambdaName[];
}

export const LEADS_FUNCTIONS: Readonly<Record<LeadsFunction, LeadsFunctionSpec>> = {
  SignupDispatch: {
    handler: "packages/bff/src/handlers/signup-dispatch.handler",
    description: "Public signup off the response path: classifies the email and calls SignUp, ForgotPassword or nothing.",
    timeoutSeconds: 30,
    memoryMb: 256,
    reservedConcurrency: 2,
    retries: 0,
    invokedBy: ["Bff"],
  },
  LeadNotice: {
    handler: "packages/bff/src/handlers/lead-notice.handler",
    description: "Internal notice of a new lead, by SES, only to the @craftech.io mailboxes of the LeadNoticeTo secret.",
    timeoutSeconds: 30,
    memoryMb: 256,
    reservedConcurrency: 2,
    retries: 0,
    invokedBy: ["Bff", "WorldJanitor"],
  },
};

/** Capability whose holders may invoke each function (infra/iam-capabilities.ts). */
export const INVOKE_CAPABILITY = { SignupDispatch: "SIGNUP_DISPATCH", LeadNotice: "LEAD_NOTICE" } as const satisfies Record<LeadsFunction, string>;

/** Holders of the invoke capability of a function, from iam-capabilities.ts. */
export function invokersOf(fn: LeadsFunction): LambdaName[] {
  return (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((name) => resolveCapabilities(LAMBDA_CAPABILITIES[name].capabilities).includes(INVOKE_CAPABILITY[fn])).sort();
}

// ---- What each role links from this module ------------------------------------------------------------

export type SignupGrantRole = "Bff" | "WorldJanitor" | "QaDriver";

/**
 * Names of what `signupGrants(fn)` (infra/leads.ts) links, beyond what the role already links: the
 * `Leads` name, the functions it may invoke (a linked Function grants exactly `lambda:InvokeFunction`
 * on it), `OriginVerifyKey` (Bff checks `X-Origin-Verify`), `Auth` (WorldJanitor reads the pool id;
 * Bff and QaDriver link it in infra/bff.ts), `GuestObjects` (the bucket names and guest prefixes a world's
 * destroy or reset deletes from, with DeleteObject there: WorldJanitor and the console's "Reiniciar demo" in
 * the Bff) and `QaWorldObjects` (the QaDriver's `world.destroy`: names and QA_WORLD_OBJECT_PREFIXES only, no
 * statement). The QaDriver invokes WorldJanitor through the link infra/bff.ts already gives it (MEMORY_PURGE).
 */
export const SIGNUP_GRANT_LINKS: Readonly<Record<SignupGrantRole, readonly string[]>> = {
  Bff: [LEADS_LINK, "SignupDispatch", "LeadNotice", "OriginVerifyKey", "GuestObjects"],
  WorldJanitor: [LEADS_LINK, "LeadNotice", "Auth", "GuestObjects"],
  QaDriver: [LEADS_LINK, "InboundMailSim", "QaWorldObjects"],
};

/** Statement kinds `signupGrants(fn)` adds to the role's `permissions`. */
export type SignupStatementKind = "leads" | "cognito" | "signupRuntime" | "qaSignupMail";

export const SIGNUP_GRANT_STATEMENTS: Readonly<Record<SignupGrantRole, readonly SignupStatementKind[]>> = {
  Bff: ["leads", "cognito", "signupRuntime"],
  WorldJanitor: ["leads", "cognito"],
  QaDriver: ["leads", "cognito", "qaSignupMail"],
};

/** What LeadNotice links: the table's name, the recipients' secret and its own SES sender. */
export const LEAD_NOTICE_LINKS = [LEADS_LINK, "LeadNoticeTo", "EmailSenderLeadNotice"] as const;
/** What SignupDispatch links: the table's name, Runtime's name (key-fenced: rate limits, bounce state, breaker), the key and the pool. */
export const SIGNUP_DISPATCH_LINKS = [LEADS_LINK, RUNTIME_KEYS_LINK, "SessionTokenKey", "Auth"] as const;
