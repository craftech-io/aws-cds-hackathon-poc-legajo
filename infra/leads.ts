// Infra of the public signup and the leads (ADR-0015 §1, §5 and §6, docs/architecture.md §3, §5 and
// §14, docs/build-plan.md WP-51). Names, fences and statements live in infra/leads-spec.ts (checked by
// leads-spec.test.ts and iam-leads.test.ts); this module only turns them into resources:
//
//   Leads           `Resource.Leads.name`, a Linkable WITHOUT permissions over the table `LeadsData`
//                   (storage-tables.ts). Each role of the closed list gets its own statement.
//   SignupDispatch  the Cognito calls of the signup, off the BFF's response path: classifies the email
//                   and calls SignUp (with the ticket PreSignUp checks), ForgotPassword or nothing.
//                   Invoked asynchronously only by Bff, no retries, reserved concurrency 2. It reads and
//                   writes only `SIGNUP#` and never writes a lead nor invokes LeadNotice (§1.4). Runtime
//                   only by `RuntimeKeys` plus its key-fenced statement (MAILSTATUS#, MAILBREAKER, RL#START#).
//   LeadNotice      the internal notice of a new lead: profile LEAD_NOTICE of the SES client, From
//                   `avisos@`, recipients only from the secret `LeadNoticeTo` and only `*@craftech.io`
//                   (IAM `ses:Recipients`); no Runtime, no Conversations. Invoked by Bff and WorldJanitor.
//   signupGrants    what the BFF (infra/bff.ts, WP-32), WorldJanitor (infra/scheduler.ts) and the
//                   QaDriver (WP-32, SC-26 only) add to their own links and permissions.
//
// The resource policies name the calling roles, resolved late (infra/bff.ts and infra/scheduler.ts are
// evaluated after this module); within one account an identity policy alone also invokes, so the
// fence that counts is that no other role holds the action (iam-capabilities.ts, iam-leads.test.ts).
//
// Verify:
//   aws --profile craftech-demos dynamodb describe-table --table-name <LeadsData name>         PK/SK, no GSI, SSE ENABLED
//   aws --profile craftech-demos dynamodb describe-time-to-live --table-name <LeadsData name>  expiresAt ENABLED
//   aws --profile craftech-demos lambda get-function-concurrency --function-name <SignupDispatch name>   2
//   aws --profile craftech-demos lambda get-function-event-invoke-config --function-name <SignupDispatch name>  MaximumRetryAttempts 0
//   aws --profile craftech-demos lambda get-policy --function-name <SignupDispatch or LeadNotice name>   only the Bff (and WorldJanitor) roles

import { Auth, userPool } from "./auth";
import type { LambdaName } from "./iam-capabilities";
import {
  GUEST_OBJECT_PREFIXES,
  LEADS_FUNCTIONS,
  LEADS_LINK,
  LEAD_NOTICE_LINKS,
  SIGNUP_DISPATCH_LINKS,
  SIGNUP_GRANT_LINKS,
  SIGNUP_GRANT_STATEMENTS,
  cognitoStatement,
  guestObjectStatementsFor,
  leadsStatement,
  qaSignupMailStatements,
  runtimeKeysStatement,
  signupRuntimeStatement,
  type GuestObjectBucket,
  type IamStatement,
  type LeadsFunction,
  type LeadsRole,
  type SignupGrantRole,
  type SignupStatementKind,
} from "./leads-spec";
import { emailLinks, inboundMailLinks } from "./messaging-email";
import { splitOutput } from "./output-arns";
import { LeadNoticeTo, OriginVerifyKey, SessionTokenKey } from "./secrets";
import { documentsBucket, inboundMailBucket, mediaBucket, uploadsBucket } from "./storage-buckets";
import { Runtime, RuntimeKeys, leadsTable } from "./storage-tables";

type PermissionStatement = Parameters<typeof sst.aws.permission>[0];

/** A statement whose resources are Outputs, as `sst.aws.permission` and `permissions` take it. */
const asPermission = (statement: IamStatement<$util.Input<string>>): PermissionStatement => ({
  actions: statement.actions,
  resources: statement.resources,
  ...(statement.conditions === undefined ? {} : { conditions: statement.conditions }),
});

/** `Resource.Leads.name` with no permission: each role gets `LEADS_ACCESS[role]` as its own statement. */
export const Leads = new sst.Linkable(LEADS_LINK, { properties: { name: leadsTable.name } });

/** The statement of one role on `Leads`. */
export function leadsPermissions(fn: LeadsRole): PermissionStatement[] {
  return [asPermission(leadsStatement(fn, leadsTable.arn))];
}

/** The Cognito statement of one role, on the app's pool only. */
export function cognitoPermissions(fn: LambdaName): PermissionStatement[] {
  const statement = cognitoStatement(fn, userPool.arn);
  return statement === undefined ? [] : [asPermission(statement)];
}

// ---- Bucket names WorldJanitor deletes from (guest worlds) ------------------------------------------

const guestBuckets: Readonly<Record<GuestObjectBucket, sst.aws.Bucket>> = {
  Documents: documentsBucket,
  Media: mediaBucket,
  Uploads: uploadsBucket,
  InboundMail: inboundMailBucket,
};

/**
 * Statements whose resources depend on a bucket name: the actions and the number of statements do not
 * (a placeholder name gives the shape), resources and conditions are lifted from the Output.
 */
function bucketPermissions(name: $util.Output<string>, build: (bucket: string) => IamStatement[]): PermissionStatement[] {
  const built = name.apply(build);
  return build("bucket").map((shape, index) => ({
    actions: shape.actions,
    resources: splitOutput(built.apply((list) => list[index]?.resources ?? []), shape.resources.length),
    ...(shape.conditions === undefined ? {} : { conditions: built.apply((list) => list[index]?.conditions ?? []) }),
  }));
}

const guestObjectPermissions = (Object.keys(GUEST_OBJECT_PREFIXES) as GuestObjectBucket[]).flatMap((bucket) =>
  bucketPermissions(guestBuckets[bucket].name, (name) => guestObjectStatementsFor(bucket, name)),
);

/** `Resource.GuestObjects.<bucket>`: the bucket names of a guest world's objects, and only their deletion. */
export const GuestObjects = new sst.Linkable("GuestObjects", {
  properties: {
    documentsBucket: documentsBucket.name,
    mediaBucket: mediaBucket.name,
    uploadsBucket: uploadsBucket.name,
    inboundMailBucket: inboundMailBucket.name,
    prefixes: GUEST_OBJECT_PREFIXES,
  },
  include: guestObjectPermissions.map((statement) => sst.aws.permission(statement)),
});

// ---- Functions ------------------------------------------------------------------------------------------

function leadsFunction(fn: LeadsFunction, link: unknown[], permissions: PermissionStatement[]): sst.aws.Function {
  const spec = LEADS_FUNCTIONS[fn];
  return new sst.aws.Function(fn, {
    description: spec.description,
    handler: spec.handler,
    timeout: `${spec.timeoutSeconds} seconds` as const,
    memory: `${spec.memoryMb} MB` as const,
    concurrency: { reserved: spec.reservedConcurrency },
    retries: spec.retries,
    link,
    permissions,
  });
}

const signupDispatchLinks: Record<(typeof SIGNUP_DISPATCH_LINKS)[number], unknown> = { Leads, RuntimeKeys, SessionTokenKey, Auth };
const leadNoticeLinks: Record<(typeof LEAD_NOTICE_LINKS)[number], unknown> = {
  Leads,
  LeadNoticeTo,
  EmailSenderLeadNotice: emailLinks("LeadNotice")[0],
};

export const signupDispatch = leadsFunction(
  "SignupDispatch",
  Object.values(signupDispatchLinks),
  [...leadsPermissions("SignupDispatch"), ...cognitoPermissions("SignupDispatch"), asPermission(runtimeKeysStatement("SignupDispatch", Runtime.arn))],
);

export const leadNotice = leadsFunction("LeadNotice", Object.values(leadNoticeLinks), leadsPermissions("LeadNotice"));

// ---- Grants for the roles of other modules --------------------------------------------------------------

export interface SignupGrants {
  readonly link: unknown[];
  readonly permissions: PermissionStatement[];
}

const grantLinks: Readonly<Record<string, unknown>> = {
  Leads,
  SignupDispatch: signupDispatch,
  LeadNotice: leadNotice,
  OriginVerifyKey,
  Auth,
  GuestObjects,
  InboundMailSim: inboundMailLinks.sim,
};

function grantStatements(fn: SignupGrantRole, kind: SignupStatementKind): PermissionStatement[] {
  switch (kind) {
    case "leads":
      return leadsPermissions(fn);
    case "cognito":
      return cognitoPermissions(fn);
    case "signupRuntime":
      return [asPermission(signupRuntimeStatement(Runtime.arn))];
    case "qaSignupMail":
      return bucketPermissions(inboundMailBucket.name, qaSignupMailStatements);
  }
}

/**
 * What a role adds for the signup and the leads (`signupGrants` of docs/build-plan.md WP-51): its links
 * (SIGNUP_GRANT_LINKS) and its statements (SIGNUP_GRANT_STATEMENTS). Bff: WP-32 in infra/bff.ts;
 * WorldJanitor: infra/scheduler.ts; QaDriver: WP-32, only the SC-26 actions of docs/test-plan.md §4.1.
 */
export function signupGrants(fn: SignupGrantRole): SignupGrants {
  return {
    link: SIGNUP_GRANT_LINKS[fn].map((name) => {
      const linked = grantLinks[name];
      if (linked === undefined) throw new Error(`infra/leads.ts has nothing named ${name} to link`);
      return linked;
    }),
    permissions: SIGNUP_GRANT_STATEMENTS[fn].flatMap((kind) => grantStatements(fn, kind)),
  };
}

// ---- Resource policies: only the roles that hold the invoke capability ------------------------------------

/** Where the role of each calling Lambda is created, and the export that holds it. */
const CALLER_EXPORTS: Readonly<Partial<Record<LambdaName, { readonly owner: string; readonly name: string; readonly load: () => Promise<object> }>>> = {
  Bff: { owner: "bff", name: "bff", load: () => import("./bff") },
  WorldJanitor: { owner: "scheduler", name: "worldJanitor", load: () => import("./scheduler") },
};

function invokePermissions(fn: LeadsFunction, target: sst.aws.Function): $util.Output<aws.lambda.Permission[]> {
  return $util.output(
    Promise.all(
      LEADS_FUNCTIONS[fn].invokedBy.map(async (caller) => {
        const source = CALLER_EXPORTS[caller];
        if (source === undefined) throw new Error(`infra/leads.ts does not know where ${caller} is created`);
        const created: unknown = Reflect.get(await source.load(), source.name);
        if (!(created instanceof sst.aws.Function)) {
          $util.log.warn(`infra/${source.owner}.ts exports no ${source.name} yet: the resource policy of ${fn} does not name the ${caller} role.`);
          return [];
        }
        return [new aws.lambda.Permission(`${fn}InvokeBy${caller}`, { action: "lambda:InvokeFunction", function: target.name, principal: created.nodes.role.arn })];
      }),
    ).then((lists) => lists.flat()),
  );
}

export const signupDispatchInvokers = invokePermissions("SignupDispatch", signupDispatch);
export const leadNoticeInvokers = invokePermissions("LeadNotice", leadNotice);
