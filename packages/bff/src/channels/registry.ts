// Instantiates the transport of each channel in the mode `ChannelModes` says (ADR-0002,
// docs/architecture-integrations.md §4): email always `live` (SES end to end), WhatsApp `simulated`
// until P-01 and `live` after. Nothing outside the transport knows the mode: the pipeline, the policy,
// the tools and the texts ask this registry for "the WhatsApp transport" and get whichever one runs.
// The factories come from the adapters (channels/email, channels/whatsapp), so the registry never
// imports a channel SDK; a mode without a factory, or a transport that answers for another channel
// or mode, is refused instead of silently falling back.
import { ChannelError, ChannelMode, ChannelName, type SendChannel, channelNameOf } from "@legajo/shared";
import { type ChannelModes, channelModes as linkedChannelModes } from "../lib/resource";

/** What the registry checks on every transport it instantiates. */
export interface TransportIdentity {
  readonly channel: SendChannel;
  readonly mode: ChannelMode;
}

export type TransportSet = { readonly [C in ChannelName]: TransportIdentity };

/** Factories per channel and mode; a mode a channel never runs in simply has none (email `simulated`). */
export type TransportFactories<T extends TransportSet> = { readonly [C in ChannelName]: Partial<Record<ChannelMode, () => T[C]>> };

export interface ChannelRegistry<T extends TransportSet> {
  mode(channel: ChannelName): ChannelMode;
  /** The transport of the channel's current mode, created once per registry. */
  transport<C extends ChannelName>(channel: C): T[C];
  /**
   * An inbound that says it came through `mode` (the phone simulator's signed envelope, or a real SNS
   * event) is accepted only when the channel runs in that mode: a simulated envelope never enters a
   * live stage, and a live event never enters a simulated one.
   */
  assertInboundMode(channel: ChannelName, mode: ChannelMode): void;
}

function sendChannelOf(channel: ChannelName): SendChannel {
  return channel === "email" ? "EMAIL" : "WHATSAPP";
}

export function createChannelRegistry<T extends TransportSet>(input: { readonly modes: ChannelModes; readonly factories: TransportFactories<T> }): ChannelRegistry<T> {
  const modes: ChannelModes = { email: ChannelMode.parse(input.modes.email), whatsapp: ChannelMode.parse(input.modes.whatsapp) };
  const created = new Map<ChannelName, TransportIdentity>();

  function instantiate<C extends ChannelName>(channel: C): T[C] {
    const mode = modes[channel];
    const factory = input.factories[channel][mode];
    if (factory === undefined) throw new ChannelError("UNAVAILABLE", sendChannelOf(channel), `no ${mode} transport for ${channel}`);
    const transport = factory();
    if (channelNameOf(transport.channel) !== channel || transport.mode !== mode) {
      throw new ChannelError("INVALID", sendChannelOf(channel), `the ${mode} factory of ${channel} built a ${transport.mode} ${transport.channel} transport`);
    }
    return transport;
  }

  return {
    mode: (channel) => modes[ChannelName.parse(channel)],
    transport<C extends ChannelName>(channel: C): T[C] {
      const cached = created.get(channel);
      if (cached !== undefined) return cached as T[C];
      const transport = instantiate(channel);
      created.set(channel, transport);
      return transport;
    },
    assertInboundMode(channel, mode) {
      if (modes[channel] !== mode) throw new ChannelError("INVALID", sendChannelOf(channel), `a ${mode} inbound reached ${channel} running ${modes[channel]}`);
    },
  };
}

/** The registry of a Lambda: modes from the linked `ChannelModes` (`Resource`, never `process.env`). */
export function channelRegistry<T extends TransportSet>(factories: TransportFactories<T>): ChannelRegistry<T> {
  return createChannelRegistry({ modes: linkedChannelModes(), factories });
}
