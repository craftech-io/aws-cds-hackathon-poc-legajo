// The port that sends the SMS code (ADR-0021) and its two adapters:
//
//   snsSmsSender     Amazon SNS `Publish` straight to the number (no topic), transactional, with a
//                    deadline and a single attempt: a retry of the SDK could deliver a second SMS
//   memorySmsSender  every message in memory: unit tests, the local UI server and the e2e mocks; no
//                    test ever sends a real SMS
//
// The text is short and carries the code; neither the number nor the code ever reaches a log.
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import type { Language } from "@legajo/shared";
import { PHONE_CODE } from "@legajo/shared/guest-limits";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";

export type SmsOutcome = "SENT" | "FAILED";

export interface SmsSender {
  send(to: string, text: string): Promise<SmsOutcome>;
}

/** The product's name in the SMS, the same in both languages. */
export const SMS_PRODUCT_NAME = "Legajo listo";

/** «Tu código de Legajo listo es 123456. Vence en 10 minutos.» */
export function smsText(code: string, lang: Language): string {
  const minutes = PHONE_CODE.ttlSeconds / 60;
  return lang === "en" ? `Your ${SMS_PRODUCT_NAME} code is ${code}. It expires in ${minutes} minutes.` : `Tu código de ${SMS_PRODUCT_NAME} es ${code}. Vence en ${minutes} minutos.`;
}

/** One attempt only: SNS may have delivered a message whose answer was lost, and a second one costs and confuses. */
export const SMS_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 5_000, connectionTimeoutMs: 1_000, maxAttempts: 1 };

export function snsSmsSender(client: SNSClient = new SNSClient(awsClientConfig(SMS_TIMEOUTS))): SmsSender {
  return {
    async send(to, text) {
      try {
        await client.send(
          new PublishCommand({
            PhoneNumber: to,
            Message: text,
            MessageAttributes: { "AWS.SNS.SMS.SMSType": { DataType: "String", StringValue: "Transactional" } },
          }),
        );
        return "SENT";
      } catch {
        return "FAILED";
      }
    },
  };
}

export interface SentSms {
  readonly to: string;
  readonly text: string;
}

export interface MemorySmsSender extends SmsSender {
  readonly sent: SentSms[];
  /** The code of the last SMS to `to`. */
  lastCode(to: string): string | undefined;
  /** Numbers whose SMS fail (a country that needs a registered sender). */
  failFor(to: string): void;
}

export function memorySmsSender(): MemorySmsSender {
  const sent: SentSms[] = [];
  const failing = new Set<string>();
  return {
    sent,
    failFor: (to) => void failing.add(to),
    lastCode: (to) => [...sent].reverse().find((sms) => sms.to === to)?.text.match(/\b(\d{6})\b/)?.[1],
    async send(to, text) {
      if (failing.has(to)) return "FAILED";
      sent.push({ to, text });
      return "SENT";
    },
  };
}
