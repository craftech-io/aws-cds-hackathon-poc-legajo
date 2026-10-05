// Which WhatsApp transport a send takes (ADR-0002, ADR-0015 §4). The stage runs WhatsApp in the mode
// `ChannelModes.whatsapp` names; in `live` only the demo phones of `SeedOverrides` (the team's real
// phones, `demoRecipients.phones`) get End User Messaging Social, outside guest worlds. A guest world
// (`GUEST#*`) and every other importer (synthetic phones of the seed and of QA) keep the phone simulator,
// so a live stage still serves the simulator to every visitor.
// The mode of the route is also the mode the policy measures the 24-hour window with (world clock in
// `simulated`, real clock in `live`).
import { type ChannelMode, normalizePhone } from "@legajo/shared";
import { SIMULATED_PHONE_NUMBER_ID } from "../channels/whatsapp/config";
import type { WhatsAppTransport } from "../channels/whatsapp/transport";
import type { WhatsAppRoute } from "./deps";
import { isGuestWorld } from "./recipient-fence";

export interface WhatsAppTransports {
  /** `ChannelModes.whatsapp` of the stage. */
  readonly mode: () => ChannelMode;
  readonly simulated: () => WhatsAppTransport;
  /** Only built when a non-guest world sends to a demo phone in a `live` stage (it needs the WABA connection, P-01). */
  readonly live: () => { readonly transport: WhatsAppTransport; readonly phoneNumberId: string };
  /** Whether a phone is a demo phone of `SeedOverrides` (`demoRecipients.phones`): the only phones live WhatsApp writes to. */
  readonly isLivePhone: (phoneE164: string) => boolean;
}

export function whatsappRouteFor(clockId: string, phoneE164: string | undefined, transports: WhatsAppTransports): WhatsAppRoute {
  const demoPhone = phoneE164 !== undefined && transports.isLivePhone(phoneE164);
  if (transports.mode() === "live" && !isGuestWorld(clockId) && demoPhone) {
    const live = transports.live();
    return { transport: live.transport, mode: "live", from: live.phoneNumberId };
  }
  return { transport: transports.simulated(), mode: "simulated", from: SIMULATED_PHONE_NUMBER_ID };
}

/** The route function of `OutboundDeps.whatsapp`, building each transport once. */
export function whatsappRoutes(transports: WhatsAppTransports): (clockId: string, phoneE164?: string) => WhatsAppRoute {
  let simulated: WhatsAppTransport | undefined;
  let live: ReturnType<WhatsAppTransports["live"]> | undefined;
  const cached: WhatsAppTransports = {
    mode: transports.mode,
    simulated: () => (simulated ??= transports.simulated()),
    live: () => (live ??= transports.live()),
    isLivePhone: transports.isLivePhone,
  };
  return (clockId, phoneE164) => whatsappRouteFor(clockId, phoneE164, cached);
}

/** `isLivePhone` over a list of demo phones, compared normalized. */
export function demoPhoneMatcher(phones: () => readonly string[]): (phoneE164: string) => boolean {
  return (phoneE164) => phones().some((phone) => normalizePhone(phone) === normalizePhone(phoneE164));
}
