// Lambda entry of `PhoneOtp` (infra/phone.ts): S3 notifications of PhoneRecordings (a Connect call
// recording, or Transcribe's output) run phone/otp.ts. The code goes out by mail with the LEAD_NOTICE
// sender profile (From `avisos@`, recipients of the secret `LeadNoticeTo`, only `*@craftech.io`); the
// bucket comes from the name-only Linkable `PhoneRecordingsBucket`. No table, no clock.
import { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { MediaFormat, StartTranscriptionJobCommand, TranscribeClient } from "@aws-sdk/client-transcribe";
import { NOTICES_ADDRESS } from "@legajo/shared";
import { z } from "zod";
import { LEAD_NOTICE_FROM_NAME } from "../leads/notice/body";
import { noticeRecipients } from "../leads/notice/notice";
import { createLogger, newCorrelationId } from "../lib/log";
import { readLinked } from "../lib/resource";
import { Attempt, OTP_LANGUAGES, PREFIXES, onObject, type OtpOutcome, type OtpPorts } from "../phone/otp";
import { linkedSecret } from "../signup/deps";
import { leadNoticeEmailClient } from "./lead-notice";

/** Seconds a listening link stays valid (bounded anyway by the role's session). */
const LINK_SECONDS = 6 * 3_600;

const S3Event = z.object({ Records: z.array(z.object({ s3: z.object({ object: z.object({ key: z.string() }) }) })) });

export function objectKeys(event: unknown): string[] {
  return S3Event.parse(event).Records.map((record) => decodeURIComponent(record.s3.object.key.replace(/\+/g, " ")));
}

function phonePorts(bucket: string, log: ReturnType<typeof createLogger>): OtpPorts {
  const s3 = new S3Client({});
  const transcribe = new TranscribeClient({});
  const email = leadNoticeEmailClient(log);
  const readText = async (key: string): Promise<string> => {
    const output = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await output.Body?.transformToString()) ?? "";
  };
  return {
    async startTranscription({ jobName, mediaKey, outputKey }) {
      await transcribe.send(
        new StartTranscriptionJobCommand({
          TranscriptionJobName: jobName,
          Media: { MediaFileUri: `s3://${bucket}/${mediaKey}` },
          MediaFormat: MediaFormat.WAV,
          IdentifyLanguage: true,
          LanguageOptions: [...OTP_LANGUAGES],
          OutputBucketName: bucket,
          OutputKey: outputKey,
          Settings: { ChannelIdentification: true },
        }),
      );
    },
    readText,
    async putJson(key, value) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: "application/json" }));
    },
    async listAttempts() {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: PREFIXES.attempts }));
      const keys = (listed.Contents ?? []).flatMap((object) => (object.Key === undefined ? [] : [object.Key]));
      const attempts = await Promise.all(keys.map(async (key) => Attempt.safeParse(JSON.parse(await readText(key)))));
      return attempts.flatMap((parsed) => (parsed.success ? [parsed.data] : []));
    },
    async linkTo(key) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: LINK_SECONDS });
    },
    async mail(subject, text) {
      const verdict = noticeRecipients(linkedSecret("LeadNoticeTo"));
      if (verdict.status !== "OK") {
        log.warn("phone_otp.no_recipients", { status: verdict.status });
        return;
      }
      for (const to of verdict.recipients) {
        await email.send({ profile: "LEAD_NOTICE", from: { address: NOTICES_ADDRESS, displayName: LEAD_NOTICE_FROM_NAME }, to, subject, text, lang: "es", kind: "PHONE_OTP" });
      }
    },
    now: () => new Date(),
  };
}

export const handler = async (event: unknown): Promise<OtpOutcome[]> => {
  const log = createLogger({ correlationId: newCorrelationId(), bindings: { service: "phone-otp" } });
  const { name } = readLinked("PhoneRecordingsBucket", z.object({ name: z.string().min(1) }));
  const ports = phonePorts(name, log);
  const outcomes: OtpOutcome[] = [];
  for (const key of objectKeys(event)) {
    const outcome = await onObject(ports, key);
    log.info("phone_otp.object", { prefix: key.split("/")[0], outcome });
    outcomes.push(outcome);
  }
  return outcomes;
};
