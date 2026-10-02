// Which WhatsApp transport a world's sends take (ADR-0002, ADR-0015 §4). The stage runs WhatsApp in the
// mode `ChannelModes.whatsapp` names; a guest world (`GUEST#*`) always takes the simulated transport,
// even when the stage runs `live`: a guest only ever writes to the phone simulator of its own world.
// The mode of the route is also the mode the policy measures the 24-hour window with (world clock in
// `simulated`, real clock in `live`).
import type { ChannelMode } from "@legajo/shared";
import { SIMULATED_PHONE_NUMBER_ID } from "../channels/whatsapp/config";
import type { WhatsAppTransport } from "../channels/whatsapp/transport";
import type { WhatsAppRoute } from "./deps";
import { isGuestWorld } from "./recipient-fence";

export interface WhatsAppTransports {
  /** `ChannelModes.whatsapp` of the stage. */
  readonly mode: () => ChannelMode;
  readonly simulated: () => WhatsAppTransport;
  /** Only built when a non-guest world sends in a `live` stage (it needs the WABA connection, P-01). */
  readonly live: () => { readonly transport: WhatsAppTransport; readonly phoneNumberId: string };
}

export function whatsappRouteFor(clockId: string, transports: WhatsAppTransports): WhatsAppRoute {
  if (transports.mode() === "live" && !isGuestWorld(clockId)) {
    const live = transports.live();
    return { transport: live.transport, mode: "live", from: live.phoneNumberId };
  }
  return { transport: transports.simulated(), mode: "simulated", from: SIMULATED_PHONE_NUMBER_ID };
}

/** The route function of `OutboundDeps.whatsapp`, building each transport once. */
export function whatsappRoutes(transports: WhatsAppTransports): (clockId: string) => WhatsAppRoute {
  let simulated: WhatsAppTransport | undefined;
  let live: ReturnType<WhatsAppTransports["live"]> | undefined;
  const cached: WhatsAppTransports = {
    mode: transports.mode,
    simulated: () => (simulated ??= transports.simulated()),
    live: () => (live ??= transports.live()),
  };
  return (clockId) => whatsappRouteFor(clockId, cached);
}
