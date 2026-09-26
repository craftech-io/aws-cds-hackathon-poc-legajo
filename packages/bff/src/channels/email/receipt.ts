// The event of a SES receipt rule's Lambda action (`invocationType Event`): `Records[0].ses.{mail,
// receipt}`. The raw MIME is not in it: the rule's S3 action stored it first under
// `<stage>/<ops|sim>/<mail.messageId>`. Validated with zod at the edge; unknown fields pass untouched.
//
// Trust comes from `receipt.dmarcVerdict` only (docs/architecture.md §13): `dkimVerdict` and
// `spfVerdict` are parsed because SES sends them, and nothing reads them. SES reports one DKIM
// verdict per message without saying which signature passed, so an attacker can add a valid signature
// of their own domain next to a forged one with an aligned `d=`.
import { z } from "zod";

export const VerdictStatus = z.enum(["PASS", "FAIL", "GRAY", "PROCESSING_FAILED", "DISABLED"]);
export type VerdictStatus = z.infer<typeof VerdictStatus>;

const Verdict = z.object({ status: VerdictStatus }).loose();

const MailHeader = z.object({ name: z.string(), value: z.string() });

export const SesMail = z
  .object({
    timestamp: z.string(),
    source: z.string(),
    messageId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/, "unexpected SES message id"),
    destination: z.array(z.string()),
    headersTruncated: z.boolean().default(false),
    headers: z.array(MailHeader).default([]),
    commonHeaders: z
      .object({
        from: z.array(z.string()).optional(),
        to: z.array(z.string()).optional(),
        messageId: z.string().optional(),
        subject: z.string().optional(),
      })
      .loose()
      .default({}),
  })
  .loose();
export type SesMail = z.infer<typeof SesMail>;

export const SesReceipt = z
  .object({
    timestamp: z.string(),
    recipients: z.array(z.string()).min(1),
    spamVerdict: Verdict,
    virusVerdict: Verdict,
    spfVerdict: Verdict.optional(),
    dkimVerdict: Verdict.optional(),
    dmarcVerdict: Verdict,
  })
  .loose();
export type SesReceipt = z.infer<typeof SesReceipt>;

export const SesReceiptEvent = z.object({
  Records: z
    .array(z.object({ eventSource: z.literal("aws:ses"), ses: z.object({ mail: SesMail, receipt: SesReceipt }) }).loose())
    .length(1),
});
export type SesReceiptEvent = z.infer<typeof SesReceiptEvent>;

export interface ReceivedMail {
  readonly mail: SesMail;
  readonly receipt: SesReceipt;
}

export function parseReceiptEvent(event: unknown): ReceivedMail {
  const record = SesReceiptEvent.parse(event).Records[0];
  if (record === undefined) throw new RangeError("a receipt event carries one record");
  return { mail: record.ses.mail, receipt: record.ses.receipt };
}

/** Every value of a header of the event (`mail.headers`), by case-insensitive name. */
export function eventHeader(mail: SesMail, name: string): string[] {
  const wanted = name.toLowerCase();
  return mail.headers.filter((header) => header.name.toLowerCase() === wanted).map((header) => header.value);
}
