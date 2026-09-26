// The phone simulator's way in (docs/architecture-integrations.md §4.2, FL-083): the console's
// `simulator.*` procedures and the `QaDriver`'s `wa.inbound` turn what the importer did into the SNS
// envelope of a real WhatsApp event (from the importer's registered phone, signed with the
// `sim-envelope` subkey) and hand it to `InboundWhatsApp` with `lambda:Invoke`, waiting for its
// summary. Nothing here decides anything: the envelope goes through the same gate and adapter as a
// live one, and `InboundWhatsApp` refuses it while WhatsApp runs live.
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { ChannelError } from "@legajo/shared";
import type { Message, MessageButton } from "../../domain/conversations";
import { awsClientConfig } from "../../lib/clients";
import type { Clock } from "../../lib/clock";
import type { SecretKey } from "../../lib/crypto";
import { withRetry } from "../../lib/retry";
import { STAGE_REGION } from "../../public-web/presign";
import { INVOKE_TIMEOUTS, SEND_RETRY } from "./config";
import type { WhatsAppSnsEvent } from "./payloads";
import { type SimulatedContent, buildSimulatedEvent, newSimulatedWamid } from "./sim-envelope";

export interface EnvelopeDelivery {
  /** Runs `InboundWhatsApp` on the event and answers its summary (`InboundSummary` of inbound.ts). */
  deliver(event: WhatsAppSnsEvent): Promise<unknown>;
}

export interface LambdaDeliveryOptions {
  /** Physical name of `InboundWhatsApp` (a linked resource of the BFF and the `QaDriver`). */
  readonly functionName: () => string;
  readonly client?: LambdaClient;
}

const RETRYABLE_INVOKE = new Set(["TooManyRequestsException", "ServiceException", "EC2ThrottledException", "TimeoutError", "ResourceConflictException"]);

/** `lambda:Invoke` (request/response) of `InboundWhatsApp` with the simulated envelope. */
export function lambdaEnvelopeDelivery(options: LambdaDeliveryOptions): EnvelopeDelivery {
  let client = options.client;
  const lambda = (): LambdaClient => (client ??= new LambdaClient({ region: STAGE_REGION, ...awsClientConfig(INVOKE_TIMEOUTS) }));
  return {
    async deliver(event) {
      const output = await withRetry(
        async () => {
          try {
            return await lambda().send(new InvokeCommand({ FunctionName: options.functionName(), InvocationType: "RequestResponse", Payload: new TextEncoder().encode(JSON.stringify(event)) }));
          } catch (error) {
            const name = error instanceof Error ? error.name : "";
            throw new ChannelError(RETRYABLE_INVOKE.has(name) ? "SEND_FAILED" : "UNAVAILABLE", "WHATSAPP", `InboundWhatsApp invoke: ${name || "error"}`, { cause: error });
          }
        },
        { attempts: SEND_RETRY.attempts, baseDelayMs: SEND_RETRY.baseDelayMs, maxDelayMs: SEND_RETRY.maxDelayMs },
      );
      if (output.FunctionError !== undefined) throw new ChannelError("UNAVAILABLE", "WHATSAPP", `InboundWhatsApp failed: ${output.FunctionError}`);
      const text = output.Payload === undefined ? "" : new TextDecoder().decode(output.Payload);
      return text === "" ? undefined : (JSON.parse(text) as unknown);
    },
  };
}

export interface PhoneSimulatorDeps {
  /** Subkey `sim-envelope` (lib/secrets.ts `subkey`). */
  readonly simEnvelopeKey: SecretKey;
  readonly delivery: EnvelopeDelivery;
  /** Real time of the tap: the envelope's timestamps are real, as Meta's are. */
  readonly realClock: Clock;
}

export interface PhoneAction {
  /** Registered phone of the importer, read by the caller from `Parties` (never from the console). */
  readonly phoneE164: string;
  readonly content: SimulatedContent;
  /** `wamid.SIM.<sha256(idempotencyKey)>` from the `QaDriver`; the console gets a new one. */
  readonly wamid?: string;
  /** The `wamid` of our message a button reply answers. */
  readonly contextWamid?: string;
}

/** What the importer does on the simulated phone, delivered to `InboundWhatsApp` like a real event. */
export async function sendFromPhone(deps: PhoneSimulatorDeps, action: PhoneAction): Promise<{ readonly wamid: string; readonly summary: unknown }> {
  const at = await deps.realClock.now();
  const wamid = action.wamid ?? newSimulatedWamid(at.getTime());
  const event = buildSimulatedEvent(deps.simEnvelopeKey, { from: action.phoneE164, wamid, content: action.content, at, ...(action.contextWamid === undefined ? {} : { contextWamid: action.contextWamid }) });
  return { wamid, summary: await deps.delivery.deliver(event) };
}

/**
 * The reply a tap on one of our buttons sends: a template's quick reply, a reply button or a list row,
 * with the button's nonce. A URL button (the upload link) opens the page and sends nothing.
 */
export function tapContent(message: Pick<Message, "kind" | "template">, button: MessageButton): SimulatedContent {
  if (button.nonce === undefined) throw new RangeError(`the ${button.action} button opens a link and sends no reply`);
  if (message.kind === "OPERATION_CHOICE" || button.action === "CHOOSE_OPERATION") return { type: "list_reply", nonce: button.nonce, title: button.title };
  if (message.template !== undefined) return { type: "template_reply", nonce: button.nonce, title: button.title };
  return { type: "button_reply", nonce: button.nonce, title: button.title };
}
