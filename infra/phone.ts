// The WhatsApp number of the app (infra/phone-spec.ts; docs/architecture.md §14 row `PhoneOtp`):
//
//   PhoneInstance     Amazon Connect instance of this app (CONNECT_MANAGED, inbound calls only). No
//                     component exists in SST, so the raw `aws.connect.*` resources are used.
//   WhatsAppNumber    a US DID claimed here; Meta's verification call reaches it.
//   OtpFlow           records the automated part of the call, listens 60 s in silence, hangs up.
//   PhoneRecordings   Connect's recordings, Transcribe's output and the attempt ledger, 30 days.
//   PhoneOtp          S3 notifications → Transcribe → the code by mail (LEAD_NOTICE profile).
//
// The instance, the number and its storage are `retainOnDelete` + `protect` in every stage, an explicit
// exception to the removal rule: a released number loses the WhatsApp registration, which Meta may ask
// to verify again until the POC is shut down.
//
// Verify:
//   aws --profile craftech-demos connect list-phone-numbers-v2 --target-arn <PhoneInstance arn>       one US DID
//   aws --profile craftech-demos connect list-instance-storage-configs --instance-id <id> --resource-type CALL_RECORDINGS
import { emailLinks } from "./messaging-email";
import { PHONE_BUCKET_ACTIONS, PHONE_OTP_FUNCTION, PHONE_PREFIXES, OTP_LIMITS, TRANSCRIBE_ACTIONS, WHATSAPP_NUMBER, connectInstanceAlias, otpFlowContent, transcribeJobArn } from "./phone-spec";
import { LeadNoticeTo } from "./secrets";

const keep = { protect: true, retainOnDelete: true } as const;
const accountId = aws.getCallerIdentityOutput({}).accountId;
const region = aws.getRegionOutput({}).region;

// ---- Recordings -----------------------------------------------------------------------------------

export const phoneRecordings = new sst.aws.Bucket("PhoneRecordings", { cors: false });

new aws.s3.BucketServerSideEncryptionConfiguration("PhoneRecordingsEncryption", {
  bucket: phoneRecordings.name,
  rules: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
});

new aws.s3.BucketLifecycleConfiguration("PhoneRecordingsLifecycle", {
  bucket: phoneRecordings.name,
  rules: [{ id: "expire", status: "Enabled", filter: {}, expiration: { days: OTP_LIMITS.retentionDays } }],
});

/** The bucket's name only: PhoneOtp's permissions on it are the explicit statement below. */
export const PhoneRecordingsBucket = new sst.Linkable("PhoneRecordingsBucket", { properties: { name: phoneRecordings.name } });

// ---- Connect ----------------------------------------------------------------------------------------

export const phoneInstance = new aws.connect.Instance(
  "PhoneInstance",
  {
    instanceAlias: connectInstanceAlias($app.name, $app.stage),
    identityManagementType: "CONNECT_MANAGED",
    inboundCallsEnabled: true,
    outboundCallsEnabled: false,
    // Off: Connect would create an untagged log group the CI role cannot create; the recordings are the evidence.
    contactFlowLogsEnabled: false,
  },
  keep,
);

const recordingsStorage = new aws.connect.InstanceStorageConfig(
  "PhoneRecordingsStorage",
  {
    instanceId: phoneInstance.id,
    resourceType: "CALL_RECORDINGS",
    storageConfig: { storageType: "S3", s3Config: { bucketName: phoneRecordings.name, bucketPrefix: PHONE_PREFIXES.recordings } },
  },
  keep,
);

export const otpFlow = new aws.connect.ContactFlow("OtpFlow", {
  instanceId: phoneInstance.id,
  name: "whatsapp-verification",
  description: "Records Meta's WhatsApp verification call for PhoneOtp; no agent, no prompt.",
  type: "CONTACT_FLOW",
  content: otpFlowContent(),
});

export const whatsappNumber = new aws.connect.PhoneNumber(
  "WhatsAppNumber",
  { targetArn: phoneInstance.arn, countryCode: WHATSAPP_NUMBER.countryCode, type: WHATSAPP_NUMBER.type, description: `WhatsApp number of ${$app.name} (${$app.stage})` },
  keep,
);

new aws.connect.PhoneNumberContactFlowAssociation("WhatsAppNumberFlow", {
  instanceId: phoneInstance.id,
  phoneNumberId: whatsappNumber.id,
  contactFlowId: otpFlow.contactFlowId,
});

// ---- PhoneOtp ---------------------------------------------------------------------------------------

const place = $util.all([accountId, region]).apply(([account, regionName]) => ({ account, region: regionName }));

export const phoneOtp = new sst.aws.Function("PhoneOtp", {
  description: PHONE_OTP_FUNCTION.description,
  handler: PHONE_OTP_FUNCTION.handler,
  timeout: `${PHONE_OTP_FUNCTION.timeoutSeconds} seconds`,
  memory: `${PHONE_OTP_FUNCTION.memoryMb} MB`,
  link: [PhoneRecordingsBucket, LeadNoticeTo, ...emailLinks("PhoneOtp")],
  permissions: [
    { actions: [...PHONE_BUCKET_ACTIONS], resources: [phoneRecordings.arn, $interpolate`${phoneRecordings.arn}/*`] },
    { actions: [...TRANSCRIBE_ACTIONS], resources: [place.apply(transcribeJobArn)] },
  ],
});

phoneRecordings.notify({
  notifications: [
    { name: "Recording", function: phoneOtp.arn, events: ["s3:ObjectCreated:*"], filterPrefix: `${PHONE_PREFIXES.recordings}/`, filterSuffix: ".wav" },
    { name: "Transcript", function: phoneOtp.arn, events: ["s3:ObjectCreated:*"], filterPrefix: `${PHONE_PREFIXES.transcripts}/`, filterSuffix: ".json" },
  ],
});

/** The number as E.164, for the operator and the outputs (`sst deploy` prints it). */
export const whatsappPhoneNumber = whatsappNumber.phoneNumber;
export const phoneStorage = recordingsStorage;
