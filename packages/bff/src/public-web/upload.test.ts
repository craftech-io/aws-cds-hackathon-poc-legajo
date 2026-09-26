import { describe, expect, it } from "vitest";
import { UPLOAD_MARK, markId, scanKeyOf } from "./links";
import {
  BUCKET,
  CLOCK,
  OPERATION_ID,
  OTHER_TOKEN,
  REAL_NOW,
  START_SIM,
  TOKEN,
  type PresignAnswer,
  header,
  jsonBody,
  listo,
  policyOf,
  presignFor,
  publicEvent,
  publicWebWorld,
  putLink,
  uploadedKey,
} from "./testing";

const MAX_BYTES = 10 * 1024 * 1024;
const PDF = "CERTIFICATE_OF_ORIGIN";

describe("[FL-009] upload link: a PDF through /u/<token>", () => {
  it("[FL-009] shows the operation number and the requested documents, and audits the access", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const response = await world.handler(publicEvent("GET", `/u/${TOKEN}`));

    expect(response.statusCode).toBe(200);
    expect(header(response, "content-type")).toBe("text/html; charset=utf-8");
    expect(response.body).toContain("Operación 4471");
    expect(response.body).toContain("Certificado de origen");
    expect(response.body).toContain("Packing list");
    expect(response.body).not.toContain("Factura comercial");
    const csp = header(response, "content-security-policy") ?? "";
    expect(csp).toContain(`connect-src 'self' https://${BUCKET}.s3.us-east-1.amazonaws.com`);
    expect(csp).toContain(`form-action 'self' https://${BUCKET}.s3.us-east-1.amazonaws.com`);
    expect(header(response, "cache-control")).toBe("no-store");
    expect(header(response, "referrer-policy")).toBe("no-referrer");

    const [opened] = await world.stores.connector.audit.listByOperation(OPERATION_ID);
    expect(opened).toMatchObject({ decision: "ACTION", action: "UPLOAD_LINK_OPENED", actor: "IMPORTER", clockId: CLOCK, refs: { operationId: OPERATION_ID, importerId: "imp-norpampa" } });
    // A paused world: the decision happens at the world's simulated instant, not the machine's.
    expect(opened?.atSim).toBe(new Date(START_SIM).toISOString());
    expect(JSON.stringify(opened)).not.toContain(TOKEN);
  });

  it("[FL-009] presigns one PDF for the exact key, 1 byte to 10 MB, application/pdf, 5 minutes", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const response = await presignFor(world, PDF);

    expect(response.statusCode).toBe(200);
    const answer = jsonBody(response) as unknown as PresignAnswer & { expiresInSeconds: number };
    expect(answer.key).toBe(`uploads/${TOKEN}/${PDF}/00000000-0000-4000-8000-000000000001.pdf`);
    expect(answer.url).toBe(`https://${BUCKET}.s3.us-east-1.amazonaws.com/`);
    expect(answer.fields.key).toBe(answer.key);
    expect(answer.fields["Content-Type"]).toBe("application/pdf");
    expect(answer.expiresInSeconds).toBe(300);
    const policy = policyOf(answer.fields);
    expect(policy.conditions).toEqual(
      expect.arrayContaining([["content-length-range", 1, MAX_BYTES], ["eq", "$Content-Type", "application/pdf"], { key: answer.key }, { bucket: BUCKET }]),
    );
    // The SDK dates the policy by the real clock.
    const lifetimeMs = Date.parse(policy.expiration) - Date.now();
    expect(lifetimeMs).toBeGreaterThan(290_000);
    expect(lifetimeMs).toBeLessThanOrEqual(300_000);

    const { runtime, audit } = world.stores.connector;
    expect((await runtime.getUploadLink(TOKEN))?.presignCount).toBe(1);
    expect(await runtime.getIdempotency(UPLOAD_MARK.presign, markId.presign(answer.key))).toMatchObject({ result: { docType: PDF } });
    expect((await audit.listByOperation(OPERATION_ID)).map((decision) => decision.action)).toEqual(["UPLOAD_PRESIGNED"]);
  });

  it("[FL-009] 'Listo' opens the scan pending, confirms the document and keeps the link for what is missing", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const key = await uploadedKey(world, PDF);
    const response = await listo(world, [key]);

    expect(response.statusCode).toBe(200);
    expect(jsonBody(response)).toEqual({
      ok: true,
      received: [PDF],
      pending: ["PACKING_LIST"],
      completed: false,
      message: "Todavía falta: packing list. Podés volver a este link para subirlo.",
    });
    const { scans } = await world.stores.connector.world.listPending(CLOCK);
    expect(scans).toEqual([expect.objectContaining({ bucket: "Uploads", objectKey: key, scanKey: scanKeyOf(key), operationId: OPERATION_ID })]);
    expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.completedAtReal).toBeUndefined();
    const done = (await world.stores.connector.audit.listByOperation(OPERATION_ID)).find((decision) => decision.action === "UPLOAD_SESSION_DONE");
    expect(done?.detail).toEqual({ docTypes: [PDF], pending: ["PACKING_LIST"], completed: false, files: 1 });

    // The same link opens again with only the packing list; "Listo" twice keeps one pending.
    const again = await world.handler(publicEvent("GET", `/u/${TOKEN}`));
    expect(again.statusCode).toBe(200);
    expect(again.body).not.toContain("Certificado de origen");
    expect(again.body).toContain("Packing list");
    expect((await listo(world, [key])).statusCode).toBe(200);
    expect((await world.stores.connector.world.listPending(CLOCK)).scans).toHaveLength(1);
  });

  it("[FL-009] uses the link up once every requested document arrived", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    await listo(world, [await uploadedKey(world, PDF)]);
    const last = await listo(world, [await uploadedKey(world, "PACKING_LIST")]);

    expect(jsonBody(last)).toMatchObject({ completed: true, pending: [], message: "Ya tenemos todo lo que pedía este link." });
    expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.completedAtReal).toBe(REAL_NOW);
    const used = await world.handler(publicEvent("GET", `/u/${TOKEN}`));
    expect(used.statusCode).toBe(410);
    expect(used.body).toContain("Link usado");
    expect(used.body).not.toContain("4471");
  });

  it("[FL-009] opens no scan pending for an object DocumentIntake already processed", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const key = await uploadedKey(world, PDF);
    await world.stores.connector.runtime.claimIdempotency({ source: UPLOAD_MARK.scanned, id: markId.scanned(key), atReal: REAL_NOW });

    expect((await listo(world, [key])).statusCode).toBe(200);
    expect((await world.stores.connector.world.listPending(CLOCK)).scans).toEqual([]);
  });

  it("[FL-009] keeps the keys of a QA run under qa/<runId>/ and stamps the rows of the QA world", async () => {
    const world = await publicWebWorld();
    const qaClock = "qa-812-1-sc07";
    await world.stores.connector.world.createClock({ clockId: qaClock, firmId: "firm-qa", mode: "PAUSED", pausedSimNow: "2026-10-15T09:58:00-03:00", startAtSim: "2026-10-15T09:58:00-03:00", worldEpoch: 1 });
    await putLink(world, { clockId: qaClock, firmId: "firm-qa", operationId: "op-7001", importerId: "imp-qa-812-1-sc07-a", runId: "812-1" });
    const key = await uploadedKey(world, PDF);

    expect(key).toBe(`qa/812-1/uploads/${TOKEN}/${PDF}/00000000-0000-4000-8000-000000000001.pdf`);
    expect((await listo(world, [key])).statusCode).toBe(200);
    expect((await world.stores.connector.world.listPending(qaClock)).scans).toEqual([expect.objectContaining({ objectKey: key, world: "qa" })]);
    const decisions = await world.stores.connector.audit.listByOperation("op-7001");
    expect(decisions.map((decision) => decision.world)).toEqual(["qa", "qa"]);
  });
});

describe("[FL-010] upload link refused", () => {
  it("[FL-010] (a) an expired link shows an error page without data, counts the metric and is denied once", async () => {
    const world = await publicWebWorld({ now: "2026-09-29T15:00:01.000Z" });
    await putLink(world);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const page = await world.handler(publicEvent("GET", `/u/${TOKEN}`));
      expect(page.statusCode).toBe(410);
      expect(page.body).toContain("Link vencido");
      expect(page.body).not.toMatch(/4471|Certificado|Packing|<script/);
    }
    const presign = await presignFor(world, PDF);
    expect(presign.statusCode).toBe(410);
    expect(jsonBody(presign)).toEqual({ ok: false, error: { code: "NOT_FOUND", reason: "LINK_EXPIRED" } });

    const invalid = world.logs().filter((line) => line.message === "public_web.link_invalid");
    expect(invalid).toHaveLength(4);
    expect(invalid[0]).toMatchObject({ metric: "UploadLinkInvalid", reason: "EXPIRED" });
    const decisions = await world.stores.connector.audit.listByOperation(OPERATION_ID);
    expect(decisions.map((decision) => [decision.decision, decision.action])).toEqual([["DENY", "UPLOAD_LINK_EXPIRED"]]);
    expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.presignCount).toBe(0);
  });

  it("[FL-010] (a) a link of a world reset after it was created is expired", async () => {
    const world = await publicWebWorld();
    await putLink(world, { createdAtReal: "2026-09-26T14:00:00.000Z" });
    await world.stores.connector.world.updateClock(CLOCK, { lastResetAtReal: "2026-09-26T14:30:00.000Z" });

    expect((await world.handler(publicEvent("GET", `/u/${TOKEN}`))).statusCode).toBe(410);
    expect((await world.stores.connector.audit.listByOperation(OPERATION_ID)).map((decision) => decision.action)).toEqual(["UPLOAD_LINK_EXPIRED"]);
  });

  it("[FL-010] (a) an unknown or malformed token counts the metric and writes no audit row", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const unknown = await world.handler(publicEvent("GET", `/u/${OTHER_TOKEN}`));
    const malformed = await world.handler(publicEvent("GET", "/u/not-a-token"));

    for (const response of [unknown, malformed]) {
      expect(response.statusCode).toBe(404);
      expect(response.body).toContain("Link no válido");
    }
    expect(world.logs().filter((line) => line.metric === "UploadLinkInvalid").map((line) => line.reason)).toEqual(["UNKNOWN", "MALFORMED"]);
    expect(await world.stores.connector.audit.listByMonth("firm-delta", "2026-10")).toEqual([]);
    expect(await world.stores.connector.audit.listByMonth("firm-delta", "2026-09")).toEqual([]);
  });

  it("[FL-010] (b) 'Listo' with a key of another link, or one never presigned, is refused with no scan pending", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    await putLink(world, { token: OTHER_TOKEN, operationId: "op-4474" });
    // Issued for the other link (operation 4474), never presigned, and a document this link does not ask for.
    const foreign = (jsonBody(await presignFor(world, PDF, OTHER_TOKEN)) as unknown as PresignAnswer).key;
    const forged = `uploads/${TOKEN}/${PDF}/00000000-0000-4000-8000-00000000abcd.pdf`;
    const notRequested = `uploads/${TOKEN}/COMMERCIAL_INVOICE/00000000-0000-4000-8000-000000000001.pdf`;

    for (const keys of [[foreign], [forged], [notRequested]]) {
      const response = await listo(world, keys);
      expect(response.statusCode).toBe(403);
      expect(jsonBody(response)).toEqual({ ok: false, error: { code: "FORBIDDEN", reason: "FOREIGN_KEY" } });
    }
    expect((await world.stores.connector.world.listPending(CLOCK)).scans).toEqual([]);
    expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.completedAtReal).toBeUndefined();
    const denials = (await world.stores.connector.audit.listByOperation(OPERATION_ID)).filter((decision) => decision.decision === "DENY");
    expect(denials).toEqual([expect.objectContaining({ action: "UPLOAD_FOREIGN_KEY", ruleIds: ["LAM-ATTACHMENT"] })]);
  });

  it("[FL-010] (c) a file declared as something else than a PDF is refused before any presign", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const response = await presignFor(world, PDF, TOKEN, { contentType: "image/png" });

    expect(response.statusCode).toBe(415);
    expect(jsonBody(response)).toEqual({ ok: false, error: { code: "INVALID", reason: "NOT_PDF" } });
    expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.presignCount).toBe(0);
    expect((await world.stores.connector.audit.listByOperation(OPERATION_ID)).map((decision) => [decision.decision, decision.action])).toEqual([["DENY", "UPLOAD_NOT_PDF"]]);
  });

  it("[FL-010] (d) a file declared over 10 MB is refused before any presign; S3 enforces the same range", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const response = await presignFor(world, PDF, TOKEN, { size: MAX_BYTES + 1 });

    expect(response.statusCode).toBe(413);
    expect(jsonBody(response)).toEqual({ ok: false, error: { code: "INVALID", reason: "TOO_LARGE" } });
    expect((await world.stores.connector.audit.listByOperation(OPERATION_ID)).map((decision) => decision.action)).toEqual(["UPLOAD_TOO_LARGE"]);
    // A page that lies about the size still meets the policy's range at S3.
    const presigned = jsonBody(await presignFor(world, PDF)) as unknown as PresignAnswer;
    expect(policyOf(presigned.fields).conditions).toContainEqual(["content-length-range", 1, MAX_BYTES]);
  });

  it("[FL-010] stops at 20 presigned POSTs per link and denies the 21st once", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    for (let index = 0; index < 20; index += 1) expect((await presignFor(world, PDF)).statusCode).toBe(200);
    for (let index = 0; index < 2; index += 1) {
      const over = await presignFor(world, PDF);
      expect(over.statusCode).toBe(409);
      expect(jsonBody(over)).toEqual({ ok: false, error: { code: "CONFLICT", reason: "PRESIGN_LIMIT" } });
    }
    const denials = (await world.stores.connector.audit.listByOperation(OPERATION_ID)).filter((decision) => decision.decision === "DENY");
    expect(denials.map((decision) => decision.action)).toEqual(["UPLOAD_PRESIGN_LIMIT"]);
  });

  it("[FL-010] refuses a document the link does not ask for", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const response = await presignFor(world, "COMMERCIAL_INVOICE");

    expect(response.statusCode).toBe(403);
    expect(jsonBody(response)).toEqual({ ok: false, error: { code: "FORBIDDEN", reason: "DOCTYPE_NOT_REQUESTED" } });
    expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.presignCount).toBe(0);
  });
});
