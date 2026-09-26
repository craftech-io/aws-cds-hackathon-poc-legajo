// S3 buckets of docs/architecture.md §6: layout, retention and CORS live in storage-keys.ts (checked by
// storage-keys.test.ts). Imported by infra/storage.ts; infra/malware.ts protects Uploads and Media.
//
//   Documents    every PDF the intake accepted, quarantined or could not classify; life of the stage
//   Uploads      the importer's browser POSTs here from /u/<token> (presigned); 1 day
//   Media        WhatsApp media (live) and the phone simulator's uploads; 90 days
//   Seed         synthetic PDFs, reader catalog, metrics batch and world templates; life of the stage
//   InboundMail  raw MIME the receipt rules store (docs/architecture.md §2); 30 days
//
// Every bucket: private (BlockPublicAccess on all four settings), HTTPS enforced by the SST component's
// policy, SSE-S3 declared explicitly, incomplete multipart uploads aborted after 7 days, `qa/` gone in
// two days wherever QA writes, and `forceDestroy` (SST's default) so removing the stage empties them.
// Component names stay at 16 characters or fewer: S3 cannot be fenced by tag, so the CI deploy role
// reaches buckets by the name prefix, and SST truncates the app name inside a longer bucket name past
// that prefix.
//
// Fixed physical names (ci-spec.ts), with the account id as suffix so nobody else can hold them:
//   Uploads, Media   the console's CSP (bootstrap response headers policy) names both origins
//   InboundMail      aws-cds-hackathon-poc-leg-inbound-mail-<account>, docs/architecture.md §1
//
// A bucket has exactly one policy and the SST component owns it (SST fails a second one), so the
// statements that let SES deliver into InboundMail are declared here, one per receipt rule of
// infra/messaging-email.ts (WP-18), each only under its own prefix and only for that rule's ARN.
// Uploads and Media keep S3's EventBridge notifications, which GuardDuty switches on: nothing may add
// an S3 notification configuration to them (it would replace that one and stop the scans).
//
// Verify: `aws --profile craftech-demos s3api get-bucket-lifecycle-configuration --bucket <name>` ·
// `get-bucket-cors` (Uploads and Media only) · `get-bucket-policy` · `get-public-access-block` ·
// `get-bucket-encryption`.

import { browserBucketName, inboundMailBucketName } from "./ci-spec";
import { appUrl } from "./dns";
import type { BucketName } from "./iam-capabilities";
import { BUCKET_SPECS, browserUploadCors, lifecycleRules, sesDeliveryStatements, type BucketNaming, type BucketSpec } from "./storage-keys";

type BucketPolicy = NonNullable<sst.aws.BucketArgs["policy"]>;

const accountId = aws.getCallerIdentityOutput({}).accountId;
const region = aws.getRegionOutput({}).region;

/** Fixed physical name of a bucket, or `undefined` to keep SST's. */
function fixedName(naming: BucketNaming): $util.Output<string> | undefined {
  switch (naming.kind) {
    case "browser":
      return accountId.apply((account) => browserBucketName($app.name, $app.stage, naming.purpose, account));
    case "inbound-mail":
      return accountId.apply((account) => inboundMailBucketName($app.name, account));
    case "sst":
      return undefined;
  }
}

function corsOf(spec: BucketSpec): sst.aws.BucketArgs["cors"] {
  if (!spec.browserUploads) return false;
  const cors = browserUploadCors(appUrl);
  return {
    allowOrigins: cors.allowOrigins,
    allowMethods: cors.allowMethods,
    allowHeaders: cors.allowHeaders,
    exposeHeaders: cors.exposeHeaders,
    maxAge: `${cors.maxAgeSeconds} seconds`,
  };
}

function bucket(name: BucketName, policy?: BucketPolicy): sst.aws.Bucket {
  const spec: BucketSpec = BUCKET_SPECS[name];
  const physicalName = fixedName(spec.naming);

  const created = new sst.aws.Bucket(name, {
    // SST's default is a permissive rule (every origin and method); only the browser buckets get one.
    cors: corsOf(spec),
    policy,
    transform: {
      bucket: (args) => {
        if (physicalName !== undefined) args.bucket = physicalName;
      },
    },
  });

  new aws.s3.BucketServerSideEncryptionConfiguration(`${name}Encryption`, {
    bucket: created.name,
    rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
  });

  new aws.s3.BucketLifecycleConfiguration(`${name}Lifecycle`, {
    bucket: created.name,
    rules: lifecycleRules(spec),
  });

  return created;
}

// SES stores received mail as the service principal, only for the receipt rules of this app.
const sesDelivery: BucketPolicy = $util
  .all([region, accountId])
  .apply(([regionName, account]) => sesDeliveryStatements({ app: $app.name, stage: $app.stage, region: regionName, accountId: account }));

export const documentsBucket = bucket("Documents");
export const uploadsBucket = bucket("Uploads");
export const mediaBucket = bucket("Media");
export const seedBucket = bucket("Seed");
export const inboundMailBucket = bucket("InboundMail", sesDelivery);

/** Every bucket of the app, by logical name (the same name `Resource.<Name>` exposes). */
export const buckets = {
  Documents: documentsBucket,
  Uploads: uploadsBucket,
  Media: mediaBucket,
  Seed: seedBucket,
  InboundMail: inboundMailBucket,
} as const satisfies Record<BucketName, sst.aws.Bucket>;
