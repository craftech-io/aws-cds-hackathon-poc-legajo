import { describe, expect, it, vi } from "vitest";
import { ChannelError, type ChannelMode, type SendChannel } from "@legajo/shared";
import { createChannelRegistry } from "./registry";

interface FakeTransport {
  readonly channel: SendChannel;
  readonly mode: ChannelMode;
  readonly id: string;
}

type Transports = { readonly email: FakeTransport; readonly whatsapp: FakeTransport };

function transport(channel: SendChannel, mode: ChannelMode, id: string): FakeTransport {
  return { channel, mode, id };
}

function registry(whatsapp: ChannelMode, factories: Partial<Record<"emailLive" | "waLive" | "waSimulated", () => FakeTransport>> = {}) {
  return createChannelRegistry<Transports>({
    modes: { email: "live", whatsapp },
    factories: {
      email: { live: factories.emailLive ?? (() => transport("EMAIL", "live", "ses")) },
      whatsapp: {
        live: factories.waLive ?? (() => transport("WHATSAPP", "live", "eum-social")),
        simulated: factories.waSimulated ?? (() => transport("WHATSAPP", "simulated", "simulated")),
      },
    },
  });
}

describe("channel registry", () => {
  it("instantiates the transport of each channel's current mode, once", () => {
    const simulated = vi.fn(() => transport("WHATSAPP", "simulated", "simulated"));
    const channels = registry("simulated", { waSimulated: simulated });
    expect(channels.mode("whatsapp")).toBe("simulated");
    expect(channels.transport("whatsapp").id).toBe("simulated");
    expect(channels.transport("whatsapp").id).toBe("simulated");
    expect(simulated).toHaveBeenCalledTimes(1);
    expect(channels.transport("email").id).toBe("ses");
    expect(registry("live").transport("whatsapp").id).toBe("eum-social");
  });

  it("has no simulated email: email always runs live (ADR-0002)", () => {
    const channels = createChannelRegistry<Transports>({
      modes: { email: "simulated", whatsapp: "simulated" },
      factories: { email: { live: () => transport("EMAIL", "live", "ses") }, whatsapp: { simulated: () => transport("WHATSAPP", "simulated", "sim") } },
    });
    expect(() => channels.transport("email")).toThrow(ChannelError);
  });

  it("refuses a factory that builds a transport of another channel or mode", () => {
    expect(() => registry("live", { waLive: () => transport("WHATSAPP", "simulated", "wrong") }).transport("whatsapp")).toThrow(/built a simulated WHATSAPP transport/);
    expect(() => registry("simulated", { emailLive: () => transport("WHATSAPP", "live", "wrong") }).transport("email")).toThrow(ChannelError);
  });

  it("rejects an inbound of the other mode in both directions", () => {
    const live = registry("live");
    expect(() => live.assertInboundMode("whatsapp", "simulated")).toThrow(/simulated inbound reached whatsapp running live/);
    expect(() => live.assertInboundMode("whatsapp", "live")).not.toThrow();
    const simulated = registry("simulated");
    expect(() => simulated.assertInboundMode("whatsapp", "live")).toThrow(ChannelError);
    expect(() => simulated.assertInboundMode("whatsapp", "simulated")).not.toThrow();
  });

  it("validates the modes it is given", () => {
    expect(() => createChannelRegistry<Transports>({ modes: { email: "live", whatsapp: "on" as ChannelMode }, factories: { email: {}, whatsapp: {} } })).toThrow();
  });
});
