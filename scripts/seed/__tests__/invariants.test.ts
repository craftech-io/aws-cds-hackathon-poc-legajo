// docs/seed-spec.md §15 over the committed seed. Invariant 10 runs the real contact policy
// (packages/bff/src/policy/, `evaluateAsOf`, with each party's zone and `HOLIDAY#AR`) over every
// historical message of the `guest` and `demo-firm-delta` templates; 20 and 21 are checked on those
// templates too. Each check is also shown to fail on a seed that breaks it, so a green run means
// something.
import { describe, expect, it } from "vitest";
import { TOUR_WINDOW } from "../../../packages/web/src/views/tour/steps";
import { START_AT_SIM, TOUR_WINDOW_END_SIM } from "../lib/constants";
import { readSeed } from "../lib/files";
import type { SeedItem } from "../lib/items";
import { batchProblems } from "../validate/batch";
import { historyProblems, decideHistory, tourWindowProblems } from "../validate/history";
import { forbiddenTermProblems, seedTexts } from "../validate/names";
import { injectorProblems } from "../validate/parties";
import { validateSeed } from "../validate/run";
import { threadProblems } from "../validate/structure";
import { worldView, type WorldView } from "../validate/world-view";

const seed = readSeed();
const holidays = seed.tables.Reference.items.filter((item) => item.entity === "Holiday").map((item) => String(item.date));

function templateView(name: "guest" | "demo-firm-delta" | "qa-min"): WorldView {
  const template = seed.templates[name];
  if (template === undefined) throw new Error(`template ${name} missing`);
  return worldView(`template ${name}`, Object.values(template.items).flat());
}

/** A copy of the view with the items `edit` returns (a mutated seed; the committed one is untouched). */
function edited(view: WorldView, edit: (items: SeedItem[]) => SeedItem[]): WorldView {
  return worldView(`${view.label} (edited)`, edit(structuredClone([...view.items])));
}

const messageOf = (view: WorldView, operationId: string, kind: string, channel: string) => view.find("Message", (item) => item.operationId === operationId && item.kind === kind && item.channel === channel);

describe("seed invariants (docs/seed-spec.md §15)", () => {
  it("holds every invariant, the manifest included, over the committed seed", async () => {
    expect((await validateSeed({ forbiddenTerms: false })).errors).toEqual([]);
  });

  describe("invariant 10: the real policy over every historical message", () => {
    for (const name of ["guest", "demo-firm-delta"] as const) {
      it(`lets out every seeded message of ${name} at the instant it went out, with every rule decided`, () => {
        const view = templateView(name);
        const verdicts = decideHistory(view, holidays);
        expect(verdicts.length).toBeGreaterThanOrEqual(name === "guest" ? 9 : 14);
        for (const verdict of verdicts) {
          expect(verdict.decision.outcome, `${verdict.operationId} ${verdict.messageId}`).toBe("ALLOW");
          expect(verdict.undecided, verdict.messageId).toEqual([]);
        }
        expect(historyProblems(view, holidays)).toEqual([]);
      });
    }

    it("sends op-4478's request after the 12/10 holiday, to the supplier at 14:20 in Rome, and its reminder at 15:00 there", () => {
      const view = templateView("guest");
      expect(Date.parse(String(messageOf(view, "op-4478", "DOCS_REQUEST", "WHATSAPP")?.sentAtSim))).toBe(Date.parse("2026-10-13T09:00:00-03:00"));
      expect(Date.parse(String(messageOf(view, "op-4478", "DOCS_REQUEST", "EMAIL")?.sentAtSim))).toBe(Date.parse("2026-10-13T14:20:00+02:00"));
      expect(Date.parse(String(messageOf(view, "op-4478", "REMINDER", "EMAIL")?.sentAtSim))).toBe(Date.parse("2026-10-14T15:00:00+02:00"));
      expect(view.find("Timer", (item) => item.operationId === "op-4478" && item.kind === "DEFERRED_SEND")).toMatchObject({ status: "FIRED", reason: "CP-HOURS-AR" });
    });

    it("fails a message moved to the holiday, one sent without its authorization and one without its ALLOW", () => {
      const view = templateView("demo-firm-delta");
      const holiday = edited(view, (items) => items.map((item) => (item.entity !== "Message" || item.kind !== "DOCS_REQUEST" || item.operationId !== "op-4487" ? item : { ...item, sentAtSim: "2026-10-12T13:00:00.000Z" })));
      expect(historyProblems(holiday, holidays).join("\n")).toMatch(/op-4487\) would be DEFER by CP-HOURS-AR/);
      const unauthorized = edited(view, (items) => items.filter((item) => !(item.entity === "SupplierAuthorization" && item.supplierId === "sup-ligurmare")));
      expect(historyProblems(unauthorized, holidays).join("\n")).toMatch(/op-4478\) would be DENY by CP-SUPPLIER-AUTH/);
      const allow = messageOf(view, "op-4489", "APPROVAL_NOTICE", "WHATSAPP")?.messageId;
      const unlogged = edited(view, (items) => items.filter((item) => !(item.entity === "Decision" && item.messageId === allow)));
      expect(historyProblems(unlogged, holidays).join("\n")).toMatch(/has no ALLOW decision/);
      const late = edited(view, (items) => items.map((item) => (item.entity === "Message" && item.deferredTimerKey !== undefined && item.operationId === "op-4478" ? { ...item, sentAtSim: "2026-10-13T12:30:00.000Z" } : item)));
      expect(historyProblems(late, holidays).join("\n")).toMatch(/did not fire at its sending time|the policy lets it out at/);
    });
  });

  describe("invariant 20: the QA injector's prefix", () => {
    it("is nobody's mailbox, and every party of the QA world carries its run and scenario", () => {
      for (const name of ["guest", "demo-firm-delta"] as const) expect(injectorProblems(templateView(name), false, seed.templates[name]?.altContacts)).toEqual([]);
      expect(injectorProblems(templateView("qa-min"), true)).toEqual([]);
      const injected = edited(templateView("guest"), (items) => items.map((item) => (item.entity === "SupplierContact" && item.contactId === "ctc-busan-1" ? { ...item, email: "qainject-812-sc15@sim.legajo.demo.craftech.io" } : item)));
      expect(injectorProblems(injected, false)).toHaveLength(1);
      const unprefixed = edited(templateView("qa-min"), (items) => items.map((item) => (item.entity === "SupplierContact" ? { ...item, email: "supplier-qingdao@sim.legajo.demo.craftech.io" } : item)));
      expect(injectorProblems(unprefixed, true).length).toBeGreaterThan(0);
    });
  });

  describe("invariant 21: the window of the guest's tour", () => {
    it("is declared by the guest template as steps.ts walks it, and holds no event of another operation", () => {
      expect(seed.templates.guest?.tour).toEqual({ operationId: "op-4471", operationNumber: "4471", windowStartSim: START_AT_SIM, windowEndSim: TOUR_WINDOW_END_SIM });
      expect(Date.parse(TOUR_WINDOW.startSim)).toBe(Date.parse(START_AT_SIM));
      expect(Date.parse(TOUR_WINDOW.endSim)).toBe(Date.parse(TOUR_WINDOW_END_SIM));
      for (const name of ["guest", "demo-firm-delta"] as const) expect(tourWindowProblems(templateView(name))).toEqual([]);
    });

    it("fails a timer of another operation inside the window and a reviewed dossier with a milestone still pending", () => {
      const view = templateView("guest");
      const intruder = edited(view, (items) => items.map((item) => (item.entity === "Timer" && item.operationId === "op-4474" && item.timerId === "DOCS_REQUEST" ? { ...item, dueAtSim: "2026-10-15T13:00:00.000Z" } : item)));
      expect(tourWindowProblems(intruder).join("\n")).toMatch(/op-4474 has MILESTONE DOCS_REQUEST .* inside the tour window/);
      const pending = edited(view, (items) => items.map((item) => (item.entity === "Timer" && item.operationId === "op-4488" && item.timerId === "ARRIVAL" ? { ...item, status: "SCHEDULED" } : item)));
      expect(tourWindowProblems(pending).join("\n")).toMatch(/op-4488 is READY_FOR_REVIEW with ARRIVAL still scheduled/);
    });
  });

  it("invariant 2: recomputes every thread tag with the test key and fails a forged one", async () => {
    const delta = worldView("data", seed.tables.Operations.items.filter((item) => item.clockId === "GLOBAL#firm-delta"));
    expect(await threadProblems([{ view: delta }])).toEqual([]);
    const forged = edited(delta, (items) => items.map((item) => (item.operationId === "op-4471" && item.entity === "Operation" ? { ...item, threadTag: "k7p2q9", threadAddress: "op-4471-k7p2q9@legajo.demo.craftech.io" } : item)));
    expect((await threadProblems([{ view: forged }])).join("\n")).toMatch(/op-4471 has a thread tag the test key does not give/);
  });

  it("invariant 11: finds a listed term without printing it, and fails closed in CI without the list", () => {
    const texts = seedTexts(seed.dataFiles, new Map());
    const found = forbiddenTermProblems(texts, { FORBIDDEN_TERMS: "# a comment\nNorpampa\n" });
    expect(found.errors.length).toBeGreaterThan(0);
    expect(found.errors.join("\n")).not.toMatch(/Norpampa/);
    expect(found.errors[0]).toMatch(/term #1 of the forbidden list/);
    expect(forbiddenTermProblems(texts, { CI: "true" }).errors).toHaveLength(1);
    expect(forbiddenTermProblems(texts, {}).warnings).toHaveLength(1);
  });

  it("invariant 14: the batch is inputs only, and an entry with a result fails", () => {
    const models = new Set((seed.templates.models?.operations ?? []).map((operation) => operation.operationId));
    expect(batchProblems(seed.batch, models)).toEqual([]);
    const withResult = structuredClone(seed.batch) as Record<string, unknown>[];
    withResult[7] = { ...withResult[7], turns: 4 };
    expect(batchProblems(withResult, models)).toEqual([expect.stringMatching(/batch entry 8 carries a result field \.turns/)]);
  });
});
