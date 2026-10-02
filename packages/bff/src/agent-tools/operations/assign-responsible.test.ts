import { beforeEach, describe, expect, it } from "vitest";
import { type ToolWorld, OPERATION, auditRows, toolWorld } from "../common/testing";
import { gatewayContext } from "../common/principal";
import { createOperationsTarget } from "./index";
import { createTestObservation, fileTestVersion, seedFirm } from "./testing";

const GROSS = "obs-4471-PL-GROSS_WEIGHT_MISMATCH";

describe("assign_responsible: the agent's choice against the firm's matrix", () => {
  let world: ToolWorld;
  let token: string;

  async function assign(input: Record<string, unknown>) {
    return createOperationsTarget(world.deps).handle({ sessionToken: token, ...input }, gatewayContext("operations___assign_responsible"));
  }

  beforeEach(async () => {
    world = await toolWorld();
    await seedFirm(world.stores);
    const version = await fileTestVersion(world.stores, { docType: "PACKING_LIST", party: "SUPPLIER" });
    await createTestObservation(world.stores, { docType: "PACKING_LIST", code: "GROSS_WEIGHT_MISMATCH", docVersionId: version.docVersionId });
    token = (await world.openTurn("DOCUMENT_READ")).token;
  });

  it("[FL-022] SUPPLIER for GROSS_WEIGHT_MISMATCH matches the matrix and is audited with RESP-MATRIX", async () => {
    expect(await assign({ observationId: GROSS, responsibleParty: "SUPPLIER", rationale: "The supplier issued the packing list." })).toEqual({ ok: true, matchesMatrix: true, matrixDefault: "SUPPLIER", flaggedForReview: false });
    const observation = await world.stores.connector.documents.getObservation(OPERATION, GROSS);
    expect(observation).toMatchObject({ responsibleParty: "SUPPLIER", matrixDefault: "SUPPLIER", matchesMatrix: true, flaggedForReview: false });
    expect((await world.stores.connector.documents.getDocument(OPERATION, "PACKING_LIST")).responsibleParty).toBe("SUPPLIER");
    const audit = (await auditRows(world)).filter((row) => row.action === "ASSIGN_RESPONSIBLE");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ decision: "ACTION", ruleIds: ["RESP-MATRIX"], actor: "AGENT", refs: { operationId: OPERATION, observationId: GROSS } });
  });

  it("[FL-042] IMPORTER for a SUPPLIER row does not match and is flagged for the firm's review", async () => {
    expect(await assign({ observationId: GROSS, responsibleParty: "IMPORTER", rationale: "The importer has the scale ticket." })).toEqual({ ok: true, matchesMatrix: false, matrixDefault: "SUPPLIER", flaggedForReview: true });
    expect(await world.stores.connector.documents.getObservation(OPERATION, GROSS)).toMatchObject({ responsibleParty: "IMPORTER", flaggedForReview: true, matchesMatrix: false });
  });

  it("[FL-042] BROKER is always flagged, even where the matrix would give it", async () => {
    expect(await assign({ observationId: GROSS, responsibleParty: "BROKER", rationale: "Needs a decision of the firm." })).toMatchObject({ ok: true, flaggedForReview: true, matchesMatrix: false });
  });

  it("[FL-042] an observation of another operation is FORBIDDEN by LAM-OP-SCOPE and never touched", async () => {
    const result = await assign({ observationId: "obs-4472-PL-GROSS_WEIGHT_MISMATCH", responsibleParty: "SUPPLIER", rationale: "Same issue." });
    expect(result).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    const denied = (await auditRows(world)).filter((row) => row.decision === "DENY");
    expect(denied.map((row) => row.ruleIds)).toEqual([["LAM-OP-SCOPE"]]);
  });

  it("[FL-040] LOW_CONFIDENCE: the matrix row SENDER is whoever sent the version", async () => {
    const version = await fileTestVersion(world.stores, { docType: "COMMERCIAL_INVOICE", party: "IMPORTER", channel: "WHATSAPP" });
    await createTestObservation(world.stores, { docType: "COMMERCIAL_INVOICE", code: "LOW_CONFIDENCE", docVersionId: version.docVersionId });
    expect(await assign({ observationId: "obs-4471-CI-LOW_CONFIDENCE", responsibleParty: "IMPORTER", rationale: "The importer sent an unreadable copy." })).toEqual({ ok: true, matchesMatrix: true, matrixDefault: "IMPORTER", flaggedForReview: false });
  });

  it("masks personal data the model put in the rationale before storing it", async () => {
    await assign({ observationId: GROSS, responsibleParty: "SUPPLIER", rationale: "Buyer CUIT 30-71234567-9 is right; the weight is wrong." });
    const { rationale } = await world.stores.connector.documents.getObservation(OPERATION, GROSS);
    expect(rationale).not.toContain("30-71234567-9");
  });

  it("an observation no longer open needs no responsible: CONFLICT", async () => {
    const observation = await world.stores.connector.documents.getObservation(OPERATION, GROSS);
    await world.stores.connector.documents.transitionObservation({ operationId: OPERATION, observationId: GROSS, to: "RESOLVED", atSim: "2026-10-14T11:00:00-03:00", by: "SYSTEM", expectedVersion: observation.version });
    expect(await assign({ observationId: GROSS, responsibleParty: "SUPPLIER", rationale: "Late." })).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
  });

  it("an unknown observation of this operation is NOT_FOUND", async () => {
    expect(await assign({ observationId: "obs-4471-CO-MISSING_SIGNATURE", responsibleParty: "SUPPLIER", rationale: "x" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});
