// PhoneOtp's logic over ports (infra/phone-spec.ts): a Connect recording starts a Transcribe job, the
// job's transcript yields the code, which is mailed to the operator. The ledger (one JSON per call under
// `otp-attempts/`) counts the calls the bot could not read in Meta's 72 h window; from the third one on
// it stops transcribing and mails the recording, so the operator listens and no attempt is wasted.
// The code itself is never stored nor logged: only the mail carries it.
import { z } from "zod";
import { extractOtp } from "./otp-code";

export const OTP_POLICY = { maxFailedCalls: 3, windowHours: 72 } as const;
/** Languages Meta may read the code in; Transcribe identifies which one per call. */
export const OTP_LANGUAGES = ["en-US", "es-US"] as const;
export const PREFIXES = { recordings: "recordings/", transcripts: "transcripts/", attempts: "otp-attempts/" } as const;

export const AttemptStatus = z.enum(["TRANSCRIBING", "READ", "UNREADABLE", "HANDED_OVER"]);
export type AttemptStatus = z.infer<typeof AttemptStatus>;

export const Attempt = z.object({ contactId: z.string().min(1), recordingKey: z.string().min(1), at: z.string().datetime(), status: AttemptStatus }).strict();
export type Attempt = z.infer<typeof Attempt>;

export interface OtpPorts {
  startTranscription(input: { readonly jobName: string; readonly mediaKey: string; readonly outputKey: string }): Promise<void>;
  readText(key: string): Promise<string>;
  putJson(key: string, value: unknown): Promise<void>;
  /** Every attempt of the ledger. */
  listAttempts(): Promise<Attempt[]>;
  /** A temporary link to listen to a recording. */
  linkTo(key: string): Promise<string>;
  mail(subject: string, text: string): Promise<void>;
  now(): Date;
}

export type OtpOutcome = "TRANSCRIBING" | "READ" | "UNREADABLE" | "HANDED_OVER" | "IGNORED";

const CONTACT_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const attemptKey = (contactId: string): string => `${PREFIXES.attempts}${contactId}.json`;
export const jobNameOf = (contactId: string): string => `otp-${contactId}`;

/** Calls in the window the bot could not read (a handed-over call counts: it was not read either). */
export function failedCalls(attempts: readonly Attempt[], now: Date): number {
  const since = now.getTime() - OTP_POLICY.windowHours * 3_600_000;
  return attempts.filter((attempt) => (attempt.status === "UNREADABLE" || attempt.status === "HANDED_OVER") && Date.parse(attempt.at) >= since).length;
}

/** The transcript text of an Amazon Transcribe output document. */
export function transcriptText(raw: string): string {
  const parsed = z.object({ results: z.object({ transcripts: z.array(z.object({ transcript: z.string() })) }) }).parse(JSON.parse(raw));
  return parsed.results.transcripts.map((part) => part.transcript).join(" ");
}

async function record(ports: OtpPorts, attempt: Attempt): Promise<void> {
  await ports.putJson(attemptKey(attempt.contactId), attempt);
}

async function handOver(ports: OtpPorts, attempt: Attempt, reason: string): Promise<OtpOutcome> {
  await record(ports, { ...attempt, status: "HANDED_OVER", at: ports.now().toISOString() });
  const link = await ports.linkTo(attempt.recordingKey);
  await ports.mail(
    "WhatsApp: escuchá la llamada de verificación",
    [`${reason} No voy a transcribir más llamadas para no gastar intentos de Meta (10 cada 72 h).`, "", `Escuchá el audio y cargá el código en el alta de WhatsApp:`, link, "", "El link vence en unas horas."].join("\n"),
  );
  return "HANDED_OVER";
}

/** A new Connect recording: transcribe it, unless three calls already failed. */
export async function onRecording(ports: OtpPorts, recordingKey: string): Promise<OtpOutcome> {
  const contactId = CONTACT_ID.exec(recordingKey)?.[0];
  if (contactId === undefined) return "IGNORED";
  const attempt: Attempt = { contactId, recordingKey, at: ports.now().toISOString(), status: "TRANSCRIBING" };
  const failed = failedCalls(await ports.listAttempts(), ports.now());
  if (failed >= OTP_POLICY.maxFailedCalls) return handOver(ports, attempt, `Ya fallaron ${failed} lecturas de la llamada de Meta.`);
  await ports.startTranscription({ jobName: jobNameOf(contactId), mediaKey: recordingKey, outputKey: `${PREFIXES.transcripts}${contactId}.json` });
  await record(ports, attempt);
  return "TRANSCRIBING";
}

/** A finished transcript: mail the code, or count the failure and hand over at the third. */
export async function onTranscript(ports: OtpPorts, transcriptKey: string): Promise<OtpOutcome> {
  const contactId = CONTACT_ID.exec(transcriptKey)?.[0];
  if (contactId === undefined) return "IGNORED";
  const attempts = await ports.listAttempts();
  const attempt = attempts.find((candidate) => candidate.contactId === contactId);
  if (attempt === undefined || attempt.status !== "TRANSCRIBING") return "IGNORED";
  const code = extractOtp(transcriptText(await ports.readText(transcriptKey)));
  if (code !== undefined) {
    await record(ports, { ...attempt, status: "READ", at: ports.now().toISOString() });
    await ports.mail(`WhatsApp: código de verificación ${code}`, [`El código que leyó Meta en la llamada es: ${code}`, "", "Cargalo en el alta de WhatsApp de AWS End User Messaging Social."].join("\n"));
    return "READ";
  }
  const failed = failedCalls(attempts, ports.now()) + 1;
  if (failed >= OTP_POLICY.maxFailedCalls) return handOver(ports, attempt, `No pude leer el código en ${failed} llamadas.`);
  await record(ports, { ...attempt, status: "UNREADABLE", at: ports.now().toISOString() });
  const link = await ports.linkTo(attempt.recordingKey);
  await ports.mail(
    `WhatsApp: no pude leer el código (llamada ${failed} de ${OTP_POLICY.maxFailedCalls})`,
    ["No encontré un código de 6 dígitos en la llamada de Meta. Pedí otra llamada en el alta.", "", "Si preferís, escuchá esta llamada:", link].join("\n"),
  );
  return "UNREADABLE";
}

/** One S3 object of PhoneRecordings: a recording or a transcript; anything else is ignored. */
export async function onObject(ports: OtpPorts, key: string): Promise<OtpOutcome> {
  if (key.startsWith(PREFIXES.recordings) && key.endsWith(".wav")) return onRecording(ports, key);
  if (key.startsWith(PREFIXES.transcripts) && key.endsWith(".json")) return onTranscript(ports, key);
  return "IGNORED";
}
