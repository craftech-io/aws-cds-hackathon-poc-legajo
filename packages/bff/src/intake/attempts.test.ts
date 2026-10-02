import { beforeEach, describe, expect, it } from "vitest";
import { START_SIM } from "../connector/testing";
import { recordCorrectionRequest, recurrenceOf } from "./attempts";
import { intakeDocument } from "./intake";
import { GROSS_WEIGHT, type IntakeWorld, OPERATION_ID, intakeWorld, pdfBytes, recognized } from "./testing";

const GROSS = "obs-4471-PL-GROSS_WEIGHT_MISMATCH";
const NET = { code: "NET_WEIGHT_MISMATCH", severity: "BLOCKING", field: "netWeightKg", expected: "12000", found: "11800" } as const;

describe("[FL-024] attempts of an observation and the two-attempt rule", () => {
  let world: IntakeWorld;
  const observation = () => world.stores.connector.documents.getObservation(OPERATION_ID, GROSS);
  const request = () => recordCorrectionRequest(world.stores.connector, { operationId: OPERATION_ID, observationIds: [GROSS], atSim: START_SIM, by: "AGENT" });

  beforeEach(async () => {
    world = await intakeWorld();
    world.script.push(recognized("PACKING_LIST", [GROSS_WEIGHT]));
    await intakeDocument(world.deps, world.event(pdfBytes("pl-v1")));
  });

  it("[FL-024] a correction request counts the first attempt", async () => {
    const [updated] = await request();
    expect(updated).toMatchObject({ status: "CORRECTION_REQUESTED", attempts: 1 });
    // Asking again for the same observation counts nothing.
    expect(await request()).toEqual([]);
    expect((await observation()).attempts).toBe(1);
  });

  it("[FL-024] the same code in a new version after a CORRECTION_REQUEST: attempts 2, ESCALATED and ESCALATE(OBSERVATION_ATTEMPTS)", async () => {
    await request();
    world.script.push(recognized("PACKING_LIST", [GROSS_WEIGHT]));
    const result = await intakeDocument(world.deps, world.event(pdfBytes("pl-v2")));
    expect(result.kind).toBe("READ");
    const escalated = await observation();
    expect(escalated).toMatchObject({ status: "ESCALATED", attempts: 2, lastDocVersionId: "dv-4471-PL-2" });
    expect(world.escalations).toEqual([expect.objectContaining({ reason: "OBSERVATION_ATTEMPTS", observationId: GROSS, docVersionId: "dv-4471-PL-2", notifyFirm: true })]);
    const [open] = await world.stores.connector.operations.listEscalations(OPERATION_ID, { status: "OPEN" });
    expect(escalated.escalationId).toBe(open?.escalationId);
    // The firm has it now: a later correction request does not move it (no third request).
    expect(await request()).toEqual([]);
    expect((await world.stores.connector.documents.getDocument(OPERATION_ID, "PACKING_LIST")).status).toBe("WITH_OBSERVATION");
  });

  it("[FL-024] a different code does not count an attempt on the first one", async () => {
    await request();
    world.script.push(recognized("PACKING_LIST", [NET]));
    await intakeDocument(world.deps, world.event(pdfBytes("pl-v2")));
    expect(await observation()).toMatchObject({ status: "RESOLVED", attempts: 1 });
    expect(await world.stores.connector.documents.getObservation(OPERATION_ID, "obs-4471-PL-NET_WEIGHT_MISMATCH")).toMatchObject({ status: "OPEN", attempts: 0 });
    expect(world.escalations).toEqual([]);
  });

  it("the same code in a version nobody asked for counts nothing", async () => {
    world.script.push(recognized("PACKING_LIST", [GROSS_WEIGHT]));
    await intakeDocument(world.deps, world.event(pdfBytes("pl-v2")));
    expect(await observation()).toMatchObject({ status: "OPEN", attempts: 0, lastDocVersionId: "dv-4471-PL-2" });
  });

  it("recurrence table: requested → counted, at the limit escalated; resolved reopens; waived stays", () => {
    expect(recurrenceOf({ status: "CORRECTION_REQUESTED", attempts: 1 })).toEqual({ kind: "TRANSITION", to: "ESCALATED", countAttempt: true, escalate: true });
    expect(recurrenceOf({ status: "CORRECTION_REQUESTED", attempts: 0 })).toEqual({ kind: "TRANSITION", to: "OPEN", countAttempt: true, escalate: false });
    expect(recurrenceOf({ status: "OPEN", attempts: 1 })).toEqual({ kind: "TRANSITION", to: "OPEN", countAttempt: false, escalate: false });
    expect(recurrenceOf({ status: "RESOLVED", attempts: 1 })).toEqual({ kind: "TRANSITION", to: "OPEN", countAttempt: false, escalate: false });
    expect(recurrenceOf({ status: "WAIVED_BY_BROKER", attempts: 2 })).toEqual({ kind: "KEEP" });
  });
});
