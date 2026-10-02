import { beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "../lib/crypto";
import { CLOCK, REAL_NOW, START_SIM } from "../connector/testing";
import { UPLOAD_MARK, markId, scanKeyOf } from "../public-web/links";
import { recordCorrectionRequest } from "./attempts";
import { intakeDocument, filedVersionOf, slotOf } from "./intake";
import { READER_RETRY_DELAY_MINUTES, retryReading } from "./retry";
import { GROSS_WEIGHT, type IntakeWorld, OPERATION_ID, UNRECOGNIZED, intakeWorld, pdfBytes, recognized } from "./testing";

const TOKEN = "Tq3x9vY2bN7mK4pL8rS1wE6uI0oA5dF3gH7jZ2cV9xB";

describe("intake_document", () => {
  let world: IntakeWorld;
  const documents = () => world.stores.connector.documents;

  beforeEach(async () => {
    world = await intakeWorld();
  });

  it("[FL-009] a PDF of the upload link, recognized without observations: the document is VALID and the version says UPLOAD_LINK", async () => {
    world.script.push(recognized("CERTIFICATE_OF_ORIGIN"));
    const event = world.event(pdfBytes("co"), { source: { party: "IMPORTER", channel: "UPLOAD_LINK", uploadToken: TOKEN }, declaredDocType: "CERTIFICATE_OF_ORIGIN" });
    const result = await intakeDocument(world.deps, event);
    expect(result.kind).toBe("READ");
    const document = await documents().getDocument(OPERATION_ID, "CERTIFICATE_OF_ORIGIN");
    expect(document).toMatchObject({ status: "VALID", validatedBy: "READER", currentVersion: 1 });
    const version = await documents().getVersion(OPERATION_ID, "CERTIFICATE_OF_ORIGIN", 1);
    expect(version.source).toMatchObject({ party: "IMPORTER", channel: "UPLOAD_LINK" });
    // The bearer token is never stored, only its hash.
    expect(version.source.uploadToken).toBe(sha256Hex(TOKEN));
    // The reader is called with the version's id as Idempotency-Key and a pre-signed GET of Documents.
    expect(world.readerCalls[0]).toMatchObject({ docVersionId: "dv-4471-CO-1", sha256: event.sha256, hints: { expectedDocType: "CERTIFICATE_OF_ORIGIN" } });
    expect(world.objects.has(version.s3Key)).toBe(true);
    // The upload's own turn (UPLOAD_COMPLETED) follows it: no DOCUMENT_READ from the intake.
    expect(world.events).toEqual([]);
  });

  it("[FL-009] an upload closes its pending scan and marks it scanned, so a later \"Listo\" opens none", async () => {
    world.script.push(recognized("CERTIFICATE_OF_ORIGIN"));
    const event = world.event(pdfBytes("co-scan"), { source: { party: "IMPORTER", channel: "UPLOAD_LINK", uploadToken: TOKEN }, declaredDocType: "CERTIFICATE_OF_ORIGIN" });
    const key = event.object.key;
    await world.stores.connector.world.putScanPending({ clockId: CLOCK, scanKey: scanKeyOf(key), bucket: "Uploads", objectKey: key, operationId: OPERATION_ID, createdAtReal: REAL_NOW });
    await intakeDocument(world.deps, event);
    expect((await world.stores.connector.world.listPending(CLOCK)).scans).toEqual([]);
    expect(await world.stores.connector.runtime.getIdempotency(UPLOAD_MARK.scanned, markId.scanned(key))).toBeDefined();
  });

  it("[FL-017] a PDF by WhatsApp, recognized: VALID and an AGENT_TURN(DOCUMENT_READ) that names the intake", async () => {
    world.script.push(recognized("PACKING_LIST"));
    const event = world.event(pdfBytes("pl"), { source: { party: "IMPORTER", channel: "WHATSAPP" }, object: { store: "MEDIA", key: "wa/media/1.pdf" } });
    world.sources.set("wa/media/1.pdf", pdfBytes("pl"));
    await intakeDocument(world.deps, event);
    expect((await documents().getDocument(OPERATION_ID, "PACKING_LIST")).status).toBe("VALID");
    expect((await documents().getVersion(OPERATION_ID, "PACKING_LIST", 1)).source.channel).toBe("WHATSAPP");
    expect(world.events).toHaveLength(1);
    expect(world.events[0]).toMatchObject({ type: "AGENT_TURN", trigger: "DOCUMENT_READ", operationId: OPERATION_ID, intakeEventIds: [event.eventId] });
    expect(await filedVersionOf(world.deps, event.eventId)).toBe("dv-4471-PL-1");
  });

  it("[FL-022] a reading with a BLOCKING observation: WITH_OBSERVATION and an OPEN observation with expected, found and no attempt yet", async () => {
    world.script.push(recognized("PACKING_LIST", [GROSS_WEIGHT]));
    const result = await intakeDocument(world.deps, world.event(pdfBytes("pl-v1")));
    expect(result.kind).toBe("READ");
    expect((await documents().getDocument(OPERATION_ID, "PACKING_LIST")).status).toBe("WITH_OBSERVATION");
    const observation = await documents().getObservation(OPERATION_ID, "obs-4471-PL-GROSS_WEIGHT_MISMATCH");
    expect(observation).toMatchObject({ status: "OPEN", severity: "BLOCKING", field: "grossWeightKg", expected: "12840", found: "12480", attempts: 0, matrixDefault: "SUPPLIER", firstDocVersionId: "dv-4471-PL-1" });
    const audit = await world.stores.connector.audit.listByOperation(OPERATION_ID);
    expect(audit.find((row) => row.action === "DOCUMENT_READ")).toMatchObject({ decision: "ACTION", actor: "SYSTEM", refs: { docVersionId: "dv-4471-PL-1" } });
  });

  it("[FL-023] the corrected version without the observation resolves it by that version and the document is VALID at version 2", async () => {
    world.script.push(recognized("PACKING_LIST", [GROSS_WEIGHT]), recognized("PACKING_LIST"));
    await intakeDocument(world.deps, world.event(pdfBytes("pl-v1")));
    await recordCorrectionRequest(world.stores.connector, { operationId: OPERATION_ID, observationIds: ["obs-4471-PL-GROSS_WEIGHT_MISMATCH"], atSim: START_SIM, by: "AGENT" });
    await intakeDocument(world.deps, world.event(pdfBytes("pl-v2")));
    const observation = await documents().getObservation(OPERATION_ID, "obs-4471-PL-GROSS_WEIGHT_MISMATCH");
    expect(observation).toMatchObject({ status: "RESOLVED", lastDocVersionId: "dv-4471-PL-2", attempts: 1 });
    expect(observation.history.at(-1)).toMatchObject({ status: "RESOLVED", docVersionId: "dv-4471-PL-2" });
    expect(await documents().getDocument(OPERATION_ID, "PACKING_LIST")).toMatchObject({ status: "VALID", currentVersion: 2 });
  });

  it("[FL-025] the type is the reader's: a 'certificate' that is the invoice already held is a duplicate and the certificate stays MISSING", async () => {
    const invoice = pdfBytes("invoice");
    world.script.push(recognized("COMMERCIAL_INVOICE"), recognized("COMMERCIAL_INVOICE"));
    await intakeDocument(world.deps, world.event(invoice));
    await documents().updateDocument(OPERATION_ID, "CERTIFICATE_OF_ORIGIN", { requestedFrom: "SUPPLIER" });
    const second = world.event(invoice);
    const result = await intakeDocument(world.deps, second);
    expect(world.readerCalls[1]?.hints).toEqual({ expectedDocType: "CERTIFICATE_OF_ORIGIN" });
    expect(result).toMatchObject({ kind: "DUPLICATE", version: { docVersionId: "dv-4471-CI-1" } });
    expect(await documents().getDocument(OPERATION_ID, "CERTIFICATE_OF_ORIGIN")).toMatchObject({ status: "MISSING", currentVersion: 0 });
    expect((await documents().getDocument(OPERATION_ID, "COMMERCIAL_INVOICE")).currentVersion).toBe(1);
    expect(await filedVersionOf(world.deps, second.eventId)).toBe("dv-4471-CI-1");
  });

  it("[FL-025] a different invoice sent for the certificate is filed as a new version of the invoice, under its own key", async () => {
    world.script.push(recognized("COMMERCIAL_INVOICE"), recognized("COMMERCIAL_INVOICE"));
    await intakeDocument(world.deps, world.event(pdfBytes("invoice-1")));
    await intakeDocument(world.deps, world.event(pdfBytes("invoice-2"), { declaredDocType: "CERTIFICATE_OF_ORIGIN" }));
    const version = await documents().getVersion(OPERATION_ID, "COMMERCIAL_INVOICE", 2);
    expect(version.s3Key).toContain("/COMMERCIAL_INVOICE/");
    expect([...world.objects.keys()].some((key) => key.includes("/CERTIFICATE_OF_ORIGIN/"))).toBe(false);
    expect((await documents().getDocument(OPERATION_ID, "CERTIFICATE_OF_ORIGIN")).status).toBe("MISSING");
  });

  it("[FL-026] UNRECOGNIZED: the version goes to unrecognized/, the document does not move and the firm gets UNRECOGNIZED_DOCUMENT", async () => {
    world.script.push(UNRECOGNIZED);
    const result = await intakeDocument(world.deps, world.event(pdfBytes("unknown")));
    expect(result.kind).toBe("UNRECOGNIZED");
    const version = await documents().getVersion(OPERATION_ID, "COMMERCIAL_INVOICE", 1);
    expect(version).toMatchObject({ state: "UNRECOGNIZED", reading: { status: "UNRECOGNIZED" } });
    expect(version.s3Key).toBe("unrecognized/op-4471/dv-4471-CI-1.pdf");
    expect([...world.objects.keys()]).toEqual([version.s3Key]);
    expect((await documents().getDocument(OPERATION_ID, "COMMERCIAL_INVOICE")).status).toBe("MISSING");
    expect(world.escalations.map((request) => request.reason)).toEqual(["UNRECOGNIZED_DOCUMENT"]);
    expect(await world.stores.connector.operations.listEscalations(OPERATION_ID, { status: "OPEN" })).toHaveLength(1);
  });

  it("a reading matched only by the id embedded in the PDF that names another invoice is not trusted: it goes to the firm", async () => {
    world.script.push(recognized("PACKING_LIST", [], { matchedBy: "EMBEDDED_ID", fields: { invoiceNumber: "OTHER-2026-0001" } }));
    const result = await intakeDocument(world.deps, world.event(pdfBytes("forged")));
    expect(result).toMatchObject({ kind: "UNRECOGNIZED", distrusted: true });
    expect((await documents().getDocument(OPERATION_ID, "PACKING_LIST")).status).toBe("MISSING");
  });

  it("[FL-040] LOW_CONFIDENCE is a BLOCKING observation whose responsible is whoever sent the version", async () => {
    world.script.push(recognized("COMMERCIAL_INVOICE", [{ code: "LOW_CONFIDENCE", severity: "WARNING" }]));
    await intakeDocument(world.deps, world.event(pdfBytes("blurry"), { source: { party: "IMPORTER", channel: "WHATSAPP" } }));
    const observation = await documents().getObservation(OPERATION_ID, "obs-4471-CI-LOW_CONFIDENCE");
    expect(observation).toMatchObject({ severity: "BLOCKING", responsibleParty: "IMPORTER", matrixDefault: "SENDER", matchesMatrix: true, status: "OPEN" });
    expect((await documents().getDocument(OPERATION_ID, "COMMERCIAL_INVOICE")).status).toBe("WITH_OBSERVATION");
  });

  it("[FL-096] a reader that does not answer leaves the version RECEIVED with a TIMER#READER_RETRY; the retry reads it and opens the turn", async () => {
    world.script.push("FAIL");
    const event = world.event(pdfBytes("pl"));
    const result = await intakeDocument(world.deps, event);
    expect(result).toMatchObject({ kind: "UNAVAILABLE", failures: 1 });
    expect(await documents().getVersion(OPERATION_ID, "COMMERCIAL_INVOICE", 1)).toMatchObject({ state: "RECEIVED", readerAttempts: 1 });
    expect((await documents().getDocument(OPERATION_ID, "COMMERCIAL_INVOICE")).status).toBe("RECEIVED");
    expect(world.timers).toHaveLength(1);
    const timer = world.timers[0];
    expect(timer).toMatchObject({ kind: "READER_RETRY", status: "SCHEDULED", payload: { docVersionId: "dv-4471-CI-1", failures: 1 } });
    expect(Date.parse(timer?.dueAtSim ?? "") - Date.parse(START_SIM)).toBe(READER_RETRY_DELAY_MINUTES * 60_000);
    expect(world.events).toEqual([]);

    world.script.push(recognized("PACKING_LIST"));
    const retried = await retryReading(world.deps, { operationId: OPERATION_ID, payload: { docVersionId: "dv-4471-CI-1", failures: 1 }, eventId: "evt_RETRY000000000000000000001", atSim: "2026-10-14T11:00:00-03:00" });
    expect(retried.kind).toBe("READ");
    // The reader said packing list: the slot version is kept as classified and the packing list is filed.
    expect(await documents().getVersion(OPERATION_ID, "COMMERCIAL_INVOICE", 1)).toMatchObject({ state: "CLASSIFIED", classifiedAs: "PACKING_LIST", classifiedBy: "SYSTEM" });
    expect((await documents().getDocument(OPERATION_ID, "COMMERCIAL_INVOICE")).status).toBe("MISSING");
    expect((await documents().getDocument(OPERATION_ID, "PACKING_LIST")).status).toBe("VALID");
    expect(world.events[0]).toMatchObject({ type: "AGENT_TURN", trigger: "DOCUMENT_READ" });
    // A second firing of the same retry finds nothing pending.
    expect(await retryReading(world.deps, { operationId: OPERATION_ID, payload: { docVersionId: "dv-4471-CI-1", failures: 1 }, eventId: "evt_RETRY000000000000000000002", atSim: "2026-10-14T11:30:00-03:00" })).toEqual({ kind: "SKIPPED", reason: "VERSION_NOT_PENDING" });
  });

  it("[FL-096] the third failed reading escalates READER_UNAVAILABLE once and the retries go on", async () => {
    world.script.push("FAIL", "FAIL", "FAIL");
    await intakeDocument(world.deps, world.event(pdfBytes("pl")));
    for (const failures of [1, 2]) await retryReading(world.deps, { operationId: OPERATION_ID, payload: { docVersionId: "dv-4471-CI-1", failures }, eventId: `evt_RETRY00000000000000000000${failures}`, atSim: START_SIM });
    expect(await documents().getVersion(OPERATION_ID, "COMMERCIAL_INVOICE", 1)).toMatchObject({ state: "READER_UNAVAILABLE", readerAttempts: 3 });
    expect(world.escalations.map((request) => request.reason)).toEqual(["READER_UNAVAILABLE"]);
    expect(world.timers).toHaveLength(3);
  });

  it("discards what is not the PDF the event names, audited with LAM-ATTACHMENT", async () => {
    const notPdf = new TextEncoder().encode("<html>no</html>");
    expect(await intakeDocument(world.deps, world.event(notPdf))).toEqual({ kind: "DISCARDED", reason: "NOT_PDF" });
    const swapped = world.event(pdfBytes("a"));
    world.sources.set(swapped.object.key, pdfBytes("b"));
    expect(await intakeDocument(world.deps, swapped)).toEqual({ kind: "DISCARDED", reason: "NOT_THE_FILE" });
    expect(await intakeDocument(world.deps, world.event(pdfBytes("c"), { clockId: "GLOBAL#firm-norte" }))).toEqual({ kind: "DISCARDED", reason: "WORLD_MISMATCH" });
    const denies = (await world.stores.connector.audit.listByOperation(OPERATION_ID)).filter((row) => row.action === "INTAKE_DISCARDED");
    expect(denies.map((row) => [row.decision, row.ruleIds, row.reason])).toEqual([
      ["DENY", ["LAM-ATTACHMENT"], "NOT_PDF"],
      ["DENY", ["LAM-ATTACHMENT"], "NOT_THE_FILE"],
      ["DENY", ["LAM-ATTACHMENT"], "WORLD_MISMATCH"],
    ]);
    expect(world.readerCalls).toEqual([]);
  });

  it("a retried event resumes from the version it filed and never files it twice", async () => {
    world.script.push(recognized("PACKING_LIST", [GROSS_WEIGHT]));
    const event = world.event(pdfBytes("pl-v1"));
    await intakeDocument(world.deps, event);
    const again = await intakeDocument(world.deps, event);
    expect(again.kind).toBe("READ");
    expect(await documents().listVersions(OPERATION_ID)).toHaveLength(1);
    expect((await documents().getObservation(OPERATION_ID, "obs-4471-PL-GROSS_WEIGHT_MISMATCH")).attempts).toBe(0);
    expect(world.readerCalls).toHaveLength(1);
  });

  it("files a PDF without a declared type in the first pending document asked of its sender", () => {
    const docs = [
      { docType: "COMMERCIAL_INVOICE" as const, status: "VALID" as const },
      { docType: "PACKING_LIST" as const, status: "MISSING" as const, requestedFrom: "IMPORTER" as const },
      { docType: "CERTIFICATE_OF_ORIGIN" as const, status: "WITH_OBSERVATION" as const, requestedFrom: "SUPPLIER" as const },
    ];
    expect(slotOf(docs, undefined, "SUPPLIER")).toBe("CERTIFICATE_OF_ORIGIN");
    expect(slotOf(docs, undefined, "IMPORTER")).toBe("PACKING_LIST");
    expect(slotOf(docs, "COMMERCIAL_INVOICE", "IMPORTER")).toBe("COMMERCIAL_INVOICE");
  });
});
