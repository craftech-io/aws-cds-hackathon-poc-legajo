import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { describe, expect, it } from "vitest";
import { ChannelError } from "@legajo/shared";
import { sha256Hex } from "../../lib/crypto";
import { formatLegajoRequest, isAutoSubmitted, parseLegajoRequest, parseOperationHeader } from "./headers";
import { type MailAttachment, acceptedAttachment, parseMime, screenAttachments } from "./mime";
import { s3MailStore } from "./store";
import { fixture, mime } from "./testing";

const PDF = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
const attachment = (index: number, contentType: string, bytes: Uint8Array): MailAttachment => ({ index, filename: `f${index}.pdf`, contentType, bytes });

describe("MIME of a received email", () => {
  it("parses the ids, sender, subject, thread and parts of reply.eml", async () => {
    const mail = await parseMime(fixture("reply.eml"));
    expect(mail).toMatchObject({
      messageId: "<reply-4471-1@sim.legajo.demo.craftech.io>",
      from: "supplier-qingdao@sim.legajo.demo.craftech.io",
      subject: "Re: [Op 4471] Missing documents: packing list, certificate of origin (Invoice QBT-2026-0917)",
      inReplyTo: ["<0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000@email.amazonses.com>"],
    });
    expect(mail.attachments.map((part) => [part.index, part.contentType, part.filename])).toEqual([
      [0, "application/pdf", "packing-list-QBT-2026-0917.pdf"],
      [1, "application/pdf", "certificate-of-origin-QBT-2026-0917.pdf"],
      [2, "image/png", "logo.png"],
    ]);
    expect(mail.header("X-Legajo-Mail-Id")).toEqual(["01JQ7ZK8X4M2N6P9R3T5V7W9Y1; clock=GLOBAL#firm-delta"]);
  });

  it("refuses a raw mail over 40 MB before parsing it", async () => {
    await expect(parseMime(new Uint8Array(40 * 1024 * 1024 + 1))).rejects.toBeInstanceOf(ChannelError);
  });
});

describe("attachment screening", () => {
  it("accepts real PDFs of up to 10 MB, five per message; rejects the rest with its reason", () => {
    const parts = [
      ...[0, 1, 2, 3, 4, 5].map((index) => attachment(index, "application/pdf", PDF)),
      attachment(6, "application/octet-stream", PDF),
      attachment(7, "application/pdf", new TextEncoder().encode("MZ not a pdf")),
      attachment(8, "application/pdf", new Uint8Array(0)),
      attachment(9, "application/pdf", Uint8Array.from([...PDF, ...new Uint8Array(10 * 1024 * 1024)])),
    ];
    const screened = screenAttachments(parts);
    expect(screened.map((entry) => (entry.status === "ACCEPTED" ? "ACCEPTED" : entry.reason))).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "TOO_MANY", "NOT_PDF", "NOT_PDF_BYTES", "EMPTY", "TOO_LARGE"]);
    expect(screened[0]?.status === "ACCEPTED" ? screened[0].sha256 : "").toBe(sha256Hex(PDF));
  });

  it("gives the intake the bytes of an accepted attachment only when index and SHA-256 match", async () => {
    const raw = mime({ from: "x@sim.legajo.demo.craftech.io", messageId: "<m@sim.legajo.demo.craftech.io>", pdfs: 2 });
    const [first] = screenAttachments((await parseMime(raw)).attachments);
    const sha = first?.status === "ACCEPTED" ? first.sha256 : "";
    expect(new TextDecoder().decode(await acceptedAttachment(raw, 0, sha))).toContain("%PDF-");
    await expect(acceptedAttachment(raw, 0, "0".repeat(64))).rejects.toBeInstanceOf(ChannelError);
    await expect(acceptedAttachment(raw, 7, sha)).rejects.toBeInstanceOf(ChannelError);
  });
});

describe("our own headers", () => {
  it("writes and reads X-Legajo-Request strictly", () => {
    const value = formatLegajoRequest({ kind: "CORRECTION_REQUEST", docTypes: ["PACKING_LIST"], observationCodes: ["GROSS_WEIGHT_MISMATCH"] });
    expect(value).toBe("kind=CORRECTION_REQUEST; docs=PACKING_LIST; obs=GROSS_WEIGHT_MISMATCH");
    expect(parseLegajoRequest(value)).toEqual({ kind: "CORRECTION_REQUEST", docTypes: ["PACKING_LIST"], observationCodes: ["GROSS_WEIGHT_MISMATCH"] });
    expect(parseLegajoRequest("kind=DOCS_REQUEST")).toEqual({ kind: "DOCS_REQUEST", docTypes: [], observationCodes: [] });
    for (const bad of ["kind=APPROVE", "kind=DOCS_REQUEST; kind=REMINDER", "kind=DOCS_REQUEST; extra=1", "docs=PACKING_LIST", "kind=DOCS_REQUEST; docs=PASSPORT"]) expect(parseLegajoRequest(bad), bad).toBeUndefined();
    expect(parseLegajoRequest(undefined)).toBeUndefined();
  });

  it("reads the operation number and the Auto-Submitted values of RFC 3834", () => {
    expect(parseOperationHeader(" 4471 ")).toBe("4471");
    expect(parseOperationHeader("4471; drop")).toBeUndefined();
    expect(isAutoSubmitted([])).toBe(false);
    expect(isAutoSubmitted(["no"])).toBe(false);
    expect(isAutoSubmitted(["No; comment"])).toBe(false);
    expect(isAutoSubmitted(["auto-replied"])).toBe(true);
    expect(isAutoSubmitted(["auto-generated"])).toBe(true);
    expect(isAutoSubmitted(["garbage"])).toBe(true);
  });
});

describe("mail store", () => {
  // The only part of the SDK's streaming body the store uses.
  const stream = (bytes: Uint8Array) => ({ transformToByteArray: async () => bytes }) as never;

  it("reads the raw MIME of the inbound bucket and writes quarantine keys only", async () => {
    const s3 = mockClient(S3Client);
    s3.on(GetObjectCommand).resolves({ Body: stream(PDF), ContentLength: PDF.byteLength });
    const store = s3MailStore({ inbound: () => ({ name: "inbound-bucket", prefix: "poc/ops/" }), quarantine: () => ({ name: "documents-bucket", prefix: "quarantine/" }), client: new S3Client({}) });
    expect(store.rawKey("abc")).toBe("poc/ops/abc");
    expect(() => store.rawKey("../x")).toThrow(RangeError);
    expect(await store.readRaw("abc")).toEqual(new Uint8Array(PDF));
    expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input).toEqual({ Bucket: "inbound-bucket", Key: "poc/ops/abc" });
    await store.putQuarantine("quarantine/op-4471/msg-1/0.pdf", PDF);
    await store.putQuarantine("qa/812-1/quarantine/op-7042-q1/msg-1/0.pdf", PDF);
    expect(s3.commandCalls(PutObjectCommand).map((call) => [call.args[0].input.Bucket, call.args[0].input.Key, call.args[0].input.ContentType])).toEqual([
      ["documents-bucket", "quarantine/op-4471/msg-1/0.pdf", "application/pdf"],
      ["documents-bucket", "qa/812-1/quarantine/op-7042-q1/msg-1/0.pdf", "application/pdf"],
    ]);
    await expect(store.putQuarantine("ops/op-4471/PACKING_LIST/v001-abcdef12.pdf", PDF)).rejects.toThrow(RangeError);
  });

  it("maps a missing or oversized object to PARSE_FAILED and an outage to UNAVAILABLE", async () => {
    const s3 = mockClient(S3Client);
    const store = s3MailStore({ inbound: () => ({ name: "b", prefix: "poc/ops/" }), quarantine: () => ({ name: "d", prefix: "quarantine/" }), client: new S3Client({}) });
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "missing", $metadata: {} }));
    await expect(store.readRaw("x")).rejects.toMatchObject({ code: "PARSE_FAILED" });
    s3.on(GetObjectCommand).resolves({ Body: stream(PDF), ContentLength: 41 * 1024 * 1024 });
    await expect(store.readRaw("x")).rejects.toMatchObject({ code: "PARSE_FAILED" });
    s3.on(GetObjectCommand).rejects(new Error("socket hang up"));
    await expect(store.readRaw("x")).rejects.toMatchObject({ code: "UNAVAILABLE", retryable: false });
  });
});
