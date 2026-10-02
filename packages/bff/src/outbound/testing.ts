// Test world of the outbound pipeline: the email channel's slice of the demo world (channels/email/
// testing.ts: op 4471 of `sup-qingdao` with thread tags that verify, an ACTIVE and a PENDING contact),
// the firm with its checklists, the importer's WhatsApp consent and the authorization to write to the
// supplier, the templates in `Reference`, and the pipeline's ports over it: the single SES client with
// its real fence and a mocked SES, the simulated WhatsApp transport (and a recording "live" one), a G2
// whose verdict the test sets, and timers and upload links written straight to the connector.
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { mockClient } from "aws-sdk-client-mock";
import { computeThreadTag, threadAddress, type ChannelMode, type TurnTrigger } from "@legajo/shared";
import { seedFirm } from "../agent-tools/operations/testing";
import { createEmailClient } from "../channels/email/outbound";
import { QINGDAO, SIM_NOW, STAGE, TEST_THREAD_KEY, emailWorld, fenceDeps, type EmailWorld } from "../channels/email/testing";
import { simulatedWhatsAppTransport } from "../channels/whatsapp/simulated-transport";
import { fakeMedia, templateItems } from "../channels/whatsapp/testing";
import type { WhatsAppSendRequest, WhatsAppTransport } from "../channels/whatsapp/transport";
import { CLOCK, FIRM, REAL_NOW, contactFixture, hashOf, operationFixture, supplierFixture } from "../connector/testing";
import type { Operation } from "../domain/operations";
import { createLogger } from "../lib/log";
import { ARGENTINA_HOLIDAYS } from "../policy/testing";
import { holidayCalendar } from "../services/holidays";
import { uploadLinkUrl } from "../copy/templates";
import type { DeferredTimerSpec, OutboundDeps } from "./deps";
import { type G2Input, type G2Verdict, GuardrailUnavailableError } from "./grounding";
import { whatsappRoutes } from "./routes";
import type { OutboundCall } from "./types";

export { CLOCK, FIRM, QINGDAO, REAL_NOW, SIM_NOW };

export const IMPORTER_PHONE = "+5491155500101";
/** Thursday 15/10 10:00 in Buenos Aires (21:00 in Qingdao): open for the importer, closed for the supplier. */
export const THU_10_AR = "2026-10-15T10:00:00-03:00";
/** Friday 16/10 10:00 in Qingdao: inside the supplier's business hours. */
export const FRI_10_QINGDAO = "2026-10-16T10:00:00+08:00";
/** A guest world of a public slot (ADR-0015 §4). */
export const GUEST_CLOCK = "GUEST#firm-guest-41";
/** A registered demo recipient (`SeedOverrides.demoRecipients`): a team inbox, never a party of a guest world. */
export const DEMO_RECIPIENT = "equipo-demo@craftech.io";

const ses = mockClient(SESv2Client);
const SEEDED = "2026-09-30T12:00:00-03:00";

export interface FakeG2 {
  readonly calls: G2Input[];
  verdict: G2Verdict | "UNAVAILABLE";
}

export interface OutboundWorld extends EmailWorld {
  readonly deps: OutboundDeps;
  readonly g2: FakeG2;
  readonly armed: DeferredTimerSpec[];
  readonly uploads: { readonly operationId: string; readonly docTypes: readonly string[] }[];
  /** What the recording "live" WhatsApp transport was asked to send. */
  readonly liveSends: WhatsAppSendRequest[];
  readonly ses: typeof ses;
  setWhatsAppMode(mode: ChannelMode): void;
  call(): OutboundCall;
  /** A closed turn's tool results, as `Runtime/TURN#` keeps them; returns the turn id. */
  turn(results: readonly { readonly tool: string; readonly output: Record<string, unknown> }[], trigger?: TurnTrigger): Promise<string>;
  /** A WhatsApp of the importer at `atSim` (it opens the 24-hour window). */
  inbound(text: string, atSim: string, messageId?: string): Promise<string>;
  /** Operation 4490 of a guest world, whose supplier contact is `contactEmail`. */
  guestOperation(contactEmail: string): Promise<Operation>;
}

async function seedWorld(world: EmailWorld): Promise<void> {
  const { parties } = world.stores.connector;
  await seedFirm(world.stores);
  await world.stores.seed.loadItems("Reference", templateItems("APPROVED"));
  await parties.grantConsent({ importerId: "imp-norpampa", medium: "SIGNED_FORM", textVersion: "2026-09-01", atSim: SEEDED, by: "SEED" });
  await parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-qingdao", authorized: true, atSim: SEEDED, by: "SEED" });
}

export async function outboundWorld(options: { readonly demoRecipients?: readonly string[] } = {}): Promise<OutboundWorld> {
  const world = await emailWorld();
  await seedWorld(world);
  const { connector } = world.stores;
  const log = createLogger({ correlationId: "corr-outbound-test", level: "debug", sink: (line) => world.lines.push(line), now: () => new Date(REAL_NOW) });
  let sesCount = 0;
  ses.reset();
  ses.on(SendEmailCommand).callsFake(() => ({ MessageId: `0100019a-ses-${String(++sesCount).padStart(6, "0")}` }));
  let wamids = 0;
  let ids = 0;
  let mode: ChannelMode = "simulated";
  const g2: FakeG2 = { calls: [], verdict: { action: "NONE", groundingScore: 0.97, relevanceScore: 0.95 } };
  const armed: DeferredTimerSpec[] = [];
  const uploads: OutboundWorld["uploads"] = [];
  const liveSends: WhatsAppSendRequest[] = [];
  const realClock = { now: async () => new Date(REAL_NOW) };
  const simulated = simulatedWhatsAppTransport({ conversations: connector.conversations, templates: connector.reference, media: fakeMedia(), realClock, log, newWamid: () => `wamid.SIM.OUT${String(++wamids).padStart(6, "0")}` });
  const live: WhatsAppTransport = {
    channel: "WHATSAPP",
    mode: "live",
    send: async (request) => (liveSends.push(request), { providerMessageId: `wamid.LIVE${liveSends.length}`, simulated: false, status: "SENT", sentAtReal: REAL_NOW }),
    fetchMedia: () => Promise.reject(new Error("not used")),
  };
  const fence = fenceDeps(world, options.demoRecipients ?? []);
  const deps: OutboundDeps = {
    data: connector,
    email: createEmailClient({ fence, world: connector.world, runtime: connector.runtime, audit: connector.audit, configurationSet: (profile) => `legajo-${profile.toLowerCase()}-${STAGE}`, stage: STAGE, now: () => new Date(REAL_NOW), newMailId: () => `01JQMAIL${String(++ids).padStart(18, "0")}`, log, ses: new SESv2Client({ region: "us-east-1" }) }),
    whatsapp: whatsappRoutes({ mode: () => mode, simulated: () => simulated, live: () => ({ transport: live, phoneNumberId: "1098765432109876" }) }),
    guardrail: {
      check: async (input) => {
        g2.calls.push(input);
        if (g2.verdict === "UNAVAILABLE") throw new GuardrailUnavailableError("down");
        return g2.verdict;
      },
    },
    g2Limits: () => ({ queryMaxChars: 1000, groundingSourceMaxChars: 50_000 }),
    fence,
    quotaTable: world.stores.client,
    nonceKey: () => "test-nonce-subkey-0123456789abcdef0123456789",
    emailHash: hashOf,
    uploadLinks: {
      async issue(input) {
        uploads.push({ operationId: input.operationId, docTypes: [...input.docTypes] });
        const token = `T${String(uploads.length).padStart(42, "0")}`;
        await connector.runtime.putUploadLink({ token, operationId: input.operationId, importerId: "imp-norpampa", firmId: input.firmId, clockId: CLOCK, docTypes: [...input.docTypes], createdAtReal: REAL_NOW, expiresAtReal: "2026-09-29T15:00:00.000Z", expiresAt: 1_790_000_000 });
        return { token, url: uploadLinkUrl(token) };
      },
    },
    arming: {
      async arm(spec) {
        armed.push(spec);
        const timer = await connector.timers.createTimer({ operationId: spec.operationId, clockId: spec.clockId, kind: "DEFERRED_SEND", timerId: spec.timerId, dueAtSim: spec.dueAtSim, status: "SCHEDULED", reason: spec.reason, payload: { ...spec.payload } });
        return { timerKey: `TIMER#DEFERRED_SEND#${timer.timerId}` };
      },
    },
    holidays: async () => holidayCalendar("AR", ARGENTINA_HOLIDAYS),
    wallClock: () => new Date(REAL_NOW),
    newId: () => `01JQ${String(++ids).padStart(22, "0")}`,
  };
  let turns = 0;
  return {
    ...world,
    deps,
    g2,
    armed,
    uploads,
    liveSends,
    ses,
    setWhatsAppMode: (next) => void (mode = next),
    call: () => ({ actor: "AGENT", correlationId: "corr-outbound-test", log, refs: { turnId: "turn-T0001" } }),
    async turn(results, trigger = "MILESTONE") {
      turns += 1;
      const turnId = `turn-T${String(turns).padStart(4, "0")}`;
      await connector.runtime.openTurn({ turnId, sessionId: `ses-T${turns}`, operationId: "op-4471", clockId: CLOCK, trigger, openedAtReal: REAL_NOW });
      for (const result of results) await connector.runtime.appendTurnResult({ turnId, tool: result.tool, output: result.output, atReal: REAL_NOW });
      return turnId;
    },
    async inbound(text, atSim, messageId = `msg-in${String(++ids).padStart(8, "0")}`) {
      await connector.conversations.appendMessage({ messageId, operationId: "op-4471", firmId: FIRM, clockId: CLOCK, direction: "IN", channel: "WHATSAPP", counterpart: "IMPORTER", importerId: "imp-norpampa", to: "simulated", from: IMPORTER_PHONE, body: text, status: "RECEIVED", author: "IMPORTER", trusted: true, simulated: true, sentAtSim: atSim, sentAtReal: REAL_NOW });
      return messageId;
    },
    async guestOperation(contactEmail) {
      await connector.world.createClock({ clockId: GUEST_CLOCK, firmId: "firm-guest-41", mode: "PAUSED", pausedSimNow: SIM_NOW, startAtSim: SIM_NOW, worldEpoch: 1 });
      await connector.parties.createSupplier(supplierFixture({ supplierId: "sup-guestqingdao", clockId: GUEST_CLOCK }));
      await connector.parties.createContact(contactFixture({ contactId: "ctc-guest-1", supplierId: "sup-guestqingdao", clockId: GUEST_CLOCK, email: contactEmail, emailHash: hashOf(`guest:${contactEmail}`) }));
      await connector.parties.setAuthorization({ importerId: "imp-norpampa", supplierId: "sup-guestqingdao", authorized: true, atSim: SEEDED, by: "SEED" });
      const tag = await computeThreadTag(TEST_THREAD_KEY, { operationNumber: "4490", clockId: GUEST_CLOCK, worldEpoch: 1 });
      const address = threadAddress("4490", tag);
      return connector.operations.createOperation({ ...operationFixture({ operationNumber: "4490", firmId: FIRM, clockId: GUEST_CLOCK, supplierId: "sup-guestqingdao", threadTag: tag }), threadAddress: address, threadClaimHash: hashOf(address) });
    },
  };
}

/** The supplier's ACTIVE contact address of op 4471 (from channels/email/testing.ts). */
export const SUPPLIER_ADDRESS = QINGDAO;
