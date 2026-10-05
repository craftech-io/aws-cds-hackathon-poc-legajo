// The WhatsApp number of the app and the bot that reads Meta's verification call (docs/architecture.md
// §14 row `PhoneOtp`), as plain data and pure functions. infra/phone.ts builds the resources from it and
// infra/phone-spec.test.ts checks every value without an account.
//
// Meta registers a WhatsApp number in AWS End User Messaging Social only after a one-time passcode; an
// Amazon Connect DID cannot receive SMS, so the code comes as a voice call. Nobody answers it: the flow
// records the automated part of the call (IVR recording, no agent, no extra charge), the recording lands
// in PhoneRecordings, and PhoneOtp transcribes it and mails the code to the operator. After three calls
// it could not read, it stops transcribing and mails the recording instead, so the operator listens to
// it and Meta's attempts (ten per 72 h) are never burnt by the bot.

/** Account and region the ARNs are built for. */
export interface PhonePlace {
  readonly account: string;
  readonly region: string;
}

/** Connect instance alias: also the subdomain `<alias>.my.connect.aws`, unique across AWS, at most 45. */
export function connectInstanceAlias(app: string, stage: string): string {
  return `${app}-${stage}`.replace(/[^A-Za-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 45).replace(/-$/, "");
}

/** The number Meta calls: a US DID (no registration, claimable at once; Meta accepts voice OTP on it). */
export const WHATSAPP_NUMBER = { countryCode: "US", type: "DID" } as const;

export const PHONE_PREFIXES = {
  /** Connect's call recordings (instance storage config `CALL_RECORDINGS`). */
  recordings: "recordings",
  /** Amazon Transcribe's output, one JSON per call. */
  transcripts: "transcripts",
  /** One JSON per call with what the bot did, the attempt ledger. */
  attempts: "otp-attempts",
} as const;

export const OTP_LIMITS = {
  /** Calls the bot may fail to read before it hands the audio to the operator. */
  maxFailedCalls: 3,
  /** Meta allows ten registration attempts per number in this window. */
  windowHours: 72,
  /** Seconds the flow listens after answering (Meta reads the code a few times and hangs up). */
  listenSeconds: 60,
  /** Recordings, transcripts and the ledger are deleted after this many days. */
  retentionDays: 30,
} as const;

/** Languages Meta may read the code in; Transcribe identifies which one per call. */
export const TRANSCRIBE_LANGUAGES = ["en-US", "es-US"] as const;

/** Transcription jobs of PhoneOtp are named `otp-<contactId>`: the IAM fence of its role. */
export const TRANSCRIBE_JOB_PREFIX = "otp-";

export const PHONE_OTP_FUNCTION = {
  handler: "packages/bff/src/handlers/phone-otp.handler",
  description: "Reads Meta's WhatsApp verification call: transcribes the Connect recording and mails the code to the operator (three failed calls → the recording instead).",
  timeoutSeconds: 60,
  memoryMb: 512,
} as const;

export const TRANSCRIBE_ACTIONS = ["transcribe:StartTranscriptionJob", "transcribe:GetTranscriptionJob"] as const;

/** Transcribe on PhoneOtp's own jobs only. */
export function transcribeJobArn(place: PhonePlace): string {
  return `arn:aws:transcribe:${place.region}:${place.account}:transcription-job/${TRANSCRIBE_JOB_PREFIX}*`;
}

/** What PhoneOtp may do on PhoneRecordings: read recordings and transcripts, write the ledger and Transcribe's output. */
export const PHONE_BUCKET_ACTIONS = ["s3:GetObject", "s3:PutObject", "s3:ListBucket"] as const;

/**
 * The inbound flow of the number (Amazon Connect flow language): record the automated interaction from
 * the first second, listen in silence for `listenSeconds` (a DTMF-only input that never matches), hang
 * up. No prompt is played: the caller is Meta's robot reading the code.
 */
export function otpFlowContent(listenSeconds: number = OTP_LIMITS.listenSeconds): string {
  const record = "Record the call";
  const listen = "Listen to the code";
  const hangUp = "Hang up";
  const toHangUp = (errorType: string) => ({ NextAction: hangUp, ErrorType: errorType });
  return JSON.stringify({
    Version: "2019-10-30",
    StartAction: record,
    Metadata: { entryPointPosition: { x: 40, y: 40 }, ActionMetadata: {} },
    Actions: [
      {
        Identifier: record,
        Type: "UpdateContactRecordingBehavior",
        Parameters: { RecordingBehavior: { RecordedParticipants: [], IVRRecordingBehavior: "Enabled" } },
        Transitions: { NextAction: listen },
      },
      {
        Identifier: listen,
        Type: "GetParticipantInput",
        Parameters: { StoreInput: "False", InputTimeLimitSeconds: String(listenSeconds), Text: " " },
        Transitions: { NextAction: hangUp, Errors: ["InputTimeLimitExceeded", "NoMatchingCondition", "NoMatchingError"].map(toHangUp) },
      },
      { Identifier: hangUp, Type: "DisconnectParticipant", Parameters: {}, Transitions: {} },
    ],
  });
}
