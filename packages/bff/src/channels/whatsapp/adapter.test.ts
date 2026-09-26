import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubkey } from "../../lib/crypto";
import { waWorld } from "./testing";

// The SST link is replaced by a plain object with the shape `Resource` has (test-only values).
const linked: Record<string, unknown> = {};
vi.mock("sst", () => ({
  Resource: new Proxy(linked, {
    get(target, name) {
      if (typeof name === "string" && name in target) return target[name];
      throw new Error(`not linked: ${String(name)}`);
    },
  }),
}));

const { resetResourceCache } = await import("../../lib/resource");
const { resetSecretCache } = await import("../../lib/secrets");
const { stageInboundWhatsAppDeps, stagePhoneSimulator, stageWhatsAppTransport } = await import("./adapter");

const MASTER = "test-only-master-key-for-the-whatsapp-stage-wiring";

function link(mode: "simulated" | "live", phoneNumberId = "not-connected"): void {
  for (const key of Object.keys(linked)) delete linked[key];
  Object.assign(linked, {
    ChannelModes: { email: "live", whatsapp: mode },
    Media: { name: "aws-cds-hackathon-poc-leg-poc-media-776805327629" },
    InboundWhatsApp: { name: "aws-cds-hackathon-poc-legajo-poc-InboundWhatsApp" },
    SessionTokenKey: { value: MASTER },
    WabaId: { value: phoneNumberId === "not-connected" ? "not-connected" : "1234567890123456" },
    WhatsAppPhoneNumberId: { value: phoneNumberId },
    SeedOverrides: { value: JSON.stringify({ demoRecipients: { emails: [], phones: ["+5491155500101"] } }) },
  });
  resetResourceCache();
  resetSecretCache();
}

beforeEach(() => link("simulated"));

describe("[FL-100] the WhatsApp channel of the stage", () => {
  it("[FL-100] builds the transport of the linked mode; live needs the WABA of P-01", async () => {
    const world = await waWorld();
    expect(stageWhatsAppTransport(world.deps.log, world.stores.connector, world.media)).toMatchObject({ channel: "WHATSAPP", mode: "simulated" });
    link("live");
    expect(() => stageWhatsAppTransport(world.deps.log, world.stores.connector, world.media)).toThrow(/P-01/);
    link("live", "phone-number-id-0123456789abcdef0123456789abcdef");
    expect(stageWhatsAppTransport(world.deps.log, world.stores.connector, world.media)).toMatchObject({ channel: "WHATSAPP", mode: "live" });
  });

  it("[FL-100] InboundWhatsApp reads its mode, subkeys and topic from the links, never from the environment", async () => {
    const world = await waWorld();
    const deps = stageInboundWhatsAppDeps({ log: world.deps.log, events: world.deps.events, replies: world.deps.replies, services: world.deps.services, data: world.stores.connector });
    expect(deps.mode).toBe("simulated");
    expect(Buffer.from(deps.keys.phoneHash)).toEqual(Buffer.from(deriveSubkey(MASTER, "phone-hash")));
    expect(Buffer.from(deps.keys.simEnvelope)).toEqual(Buffer.from(deriveSubkey(MASTER, "sim-envelope")));
    expect(deps.source).toEqual({ topicArn: "arn:aws:sns:us-east-1:776805327629:aws-cds-hackathon-poc-legajo-wa-inbound", accountId: "776805327629" });
    expect(deps.transport.mode).toBe("simulated");
  });

  it("[FL-083] the phone simulator signs with its subkey and invokes the linked InboundWhatsApp", async () => {
    const lambda = mockClient(LambdaClient);
    lambda.on(InvokeCommand).resolves({ StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ records: [] })) as never });
    const simulator = stagePhoneSimulator();
    expect(Buffer.from(simulator.simEnvelopeKey)).toEqual(Buffer.from(deriveSubkey(MASTER, "sim-envelope")));
    expect(await simulator.delivery.deliver({ Records: [] as never })).toEqual({ records: [] });
    expect(lambda.commandCalls(InvokeCommand)[0]?.args[0].input.FunctionName).toBe("aws-cds-hackathon-poc-legajo-poc-InboundWhatsApp");
    lambda.restore();
  });
});
