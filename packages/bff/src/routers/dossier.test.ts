import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { QuotaExceededError } from "@legajo/shared/errors";
import { RateCard } from "../domain/reference";
import { CLOCK, FIRM, OPERATION, START_SIM, fileVersion, openObservation, readyForReview, setDocuments } from "../services/operations-admin/testing";
import { GUEST, GUEST_CLOCK, consoleServiceWorld, guestOperation } from "./console-testing";
import { COST_PER_DOSSIER_METRIC } from "./dossier";
import { DIEGO, MARTINA, PABLO, SUBS, principalOf } from "./testing";

const STALE_SIGN_IN = { authTime: Date.parse("2026-09-26T14:00:00.000Z") / 1000 };

function causeOf(error: unknown): unknown {
  return error instanceof TRPCError ? error.cause : undefined;
}

describe("dossier router", () => {
  it("[FL-073] a broker with a recent sign-in approves a dossier ready for review through the console", async () => {
    const world = await consoleServiceWorld();
    await readyForReview(world);
    const answer = await world.caller(DIEGO).dossier.approve({ operationId: OPERATION });
    expect(answer).toMatchObject({ operationId: OPERATION, dossierStatus: "APPROVED", approvedBy: "brk-delta-diego" });
    expect(answer).not.toHaveProperty("ok");
    expect(world.events).toMatchObject([{ type: "OUTBOUND_SEND", kind: "APPROVAL_NOTICE", author: "BROKER:brk-delta-diego" }]);
    expect((await world.stores.connector.audit.listByOperation(OPERATION)).some((row) => row.action === "APPROVED")).toBe(true);
  });

  it("[FL-073] a sign-in older than 15 minutes is refused with LOGIN_NOT_RECENT before anything changes", async () => {
    const world = await consoleServiceWorld();
    await readyForReview(world);
    const stale = principalOf(FIRM, "BROKER", SUBS.diego, "brk-delta-diego", STALE_SIGN_IN);
    await expect(world.caller(stale).dossier.approve({ operationId: OPERATION })).rejects.toMatchObject({ code: "FORBIDDEN", cause: { reason: "LOGIN_NOT_RECENT" } });
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("READY_FOR_REVIEW");
  });

  it("[FL-075] an analyst calling dossier.approve gets 403 ROLE_NOT_ALLOWED, audited, and the dossier stays as it was", async () => {
    const world = await consoleServiceWorld();
    await readyForReview(world);
    await expect(world.caller(MARTINA).dossier.approve({ operationId: OPERATION })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const denies = await world.stores.connector.audit.listByDecision(FIRM, "DENY");
    expect(denies).toMatchObject([{ action: "ROLE_NOT_ALLOWED", refs: { brokerId: "brk-delta-martina" } }]);
    expect((await world.stores.connector.operations.getOperation(OPERATION)).dossierStatus).toBe("READY_FOR_REVIEW");
    expect(world.events).toEqual([]);
  });

  it("[FL-076] reopens an approved dossier with its reason; another firm cannot", async () => {
    const world = await consoleServiceWorld();
    await readyForReview(world);
    await world.caller(DIEGO).dossier.approve({ operationId: OPERATION });
    await expect(world.caller(PABLO).dossier.reopen({ operationId: OPERATION, reason: "Corregir factura" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const answer = await world.caller(DIEGO).dossier.reopen({ operationId: OPERATION, reason: "Corregir factura" });
    expect(answer).toMatchObject({ operationId: OPERATION, dossierStatus: "REOPENED" });
    const reopened = (await world.stores.connector.audit.listByOperation(OPERATION)).find((row) => row.action === "REOPENED");
    expect(reopened).toMatchObject({ reason: "Corregir factura", refs: { brokerId: "brk-delta-diego" } });
  });

  it("[FL-043] an analyst waives an observation; once the dossier is complete the approval is requested", async () => {
    const world = await consoleServiceWorld();
    const docVersionId = await fileVersion(world, "PACKING_LIST", "READ");
    const observationId = await openObservation(world, "PACKING_LIST", docVersionId);
    await setDocuments(world, { COMMERCIAL_INVOICE: "VALID", PACKING_LIST: "WITH_OBSERVATION", CERTIFICATE_OF_ORIGIN: "VALID" });
    const answer = await world.caller(MARTINA).dossier.waiveObservation({ operationId: OPERATION, observationId, reason: "Diferencia de redondeo aceptada" });
    expect(answer).toMatchObject({ status: "WAIVED_BY_BROKER", documentStatus: "VALID", approvalRequested: true });
    expect(world.approvals).toMatchObject([{ operationId: OPERATION }]);
  });

  it("[FL-044] classifies an unrecognized version and discards another", async () => {
    const world = await consoleServiceWorld();
    const first = await fileVersion(world, "CERTIFICATE_OF_ORIGIN", "UNRECOGNIZED");
    const answer = await world.caller(MARTINA).dossier.classifyDocument({ operationId: OPERATION, docVersionId: first, outcome: "CLASSIFY", docType: "CERTIFICATE_OF_ORIGIN" });
    expect(answer).toMatchObject({ outcome: "CLASSIFY", classifiedAs: "CERTIFICATE_OF_ORIGIN" });
    const second = await fileVersion(world, "PACKING_LIST", "UNRECOGNIZED");
    expect(await world.caller(DIEGO).dossier.classifyDocument({ operationId: OPERATION, docVersionId: second, outcome: "DISCARD" })).toMatchObject({ outcome: "DISCARD" });
    await expect(world.caller(MARTINA).dossier.classifyDocument({ operationId: OPERATION, docVersionId: second, outcome: "DISCARD", docType: "PACKING_LIST" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("issues the importer's upload link for what the importer may bring, and refuses the rest", async () => {
    const world = await consoleServiceWorld();
    const link = await world.caller(DIEGO).dossier.requestUploadLink({ operationId: OPERATION, docTypes: ["COMMERCIAL_INVOICE"] });
    expect(link).toMatchObject({ operationId: OPERATION, docTypes: ["COMMERCIAL_INVOICE"], url: expect.stringContaining("/u/") });
    await setDocuments(world, { PACKING_LIST: "VALID" });
    await expect(world.caller(DIEGO).dossier.requestUploadLink({ operationId: OPERATION, docTypes: ["PACKING_LIST"] })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(world.caller(PABLO).dossier.requestUploadLink({ operationId: OPERATION, docTypes: ["COMMERCIAL_INVOICE"] })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("[FL-111] a guest world's spent PDF_UPLOADS refuses the upload link with QUOTA_EXCEEDED and its renewal", async () => {
    const world = await consoleServiceWorld({ guestWorld: true });
    const { operationId } = await guestOperation(world);
    expect(await world.caller(GUEST).dossier.requestUploadLink({ operationId, docTypes: ["COMMERCIAL_INVOICE"] })).toMatchObject({ operationId });
    await world.exhaust(GUEST_CLOCK, "PDF_UPLOADS");
    const refused = await world.caller(GUEST).dossier.requestUploadLink({ operationId, docTypes: ["COMMERCIAL_INVOICE"] }).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(causeOf(refused)).toBeInstanceOf(QuotaExceededError);
    expect(causeOf(refused)).toMatchObject({ kind: "PDF_UPLOADS", resetsAtReal: expect.any(String) });
  });

  it("emits CostPerDossier with the approved dossier's cost only when every rate is verified", async () => {
    const world = await consoleServiceWorld();
    await readyForReview(world);
    const ref = { firmId: FIRM, source: "WORLD" as const, clockId: CLOCK, operationId: OPERATION };
    await world.stores.connector.metrics.incrementKpi(ref, { inputTokens: 1_000_000, emailSent: 1_000 }, { agentMode: "REAL" });
    const stamp = { createdAt: START_SIM, updatedAt: START_SIM, version: 1, source: "https://aws.amazon.com/pricing/", asOf: "2026-09-20", provisional: false };
    vi.spyOn(world.stores.connector.reference, "listRateCard").mockResolvedValue([
      RateCard.parse({ ...stamp, rateId: "bedrock:global.anthropic.claude-haiku-4-5-20251001-v1-0:input", price: 5, unit: "PER_1M_TOKENS" }),
      RateCard.parse({ ...stamp, rateId: "ses:outbound", price: 0.1, unit: "PER_1K_MESSAGES" }),
    ]);
    await world.caller(DIEGO).dossier.approve({ operationId: OPERATION });
    expect(world.metrics(COST_PER_DOSSIER_METRIC)).toMatchObject([{ costUsd: 5.1 }]);
  });

  it("emits no CostPerDossier while a rate is unverified", async () => {
    const world = await consoleServiceWorld();
    await readyForReview(world);
    await world.stores.connector.metrics.incrementKpi({ firmId: FIRM, source: "WORLD", clockId: CLOCK, operationId: OPERATION }, { inputTokens: 1_000 }, { agentMode: "REAL" });
    await world.caller(DIEGO).dossier.approve({ operationId: OPERATION });
    expect(world.metrics(COST_PER_DOSSIER_METRIC)).toEqual([]);
  });
});
