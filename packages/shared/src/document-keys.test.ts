import { describe, expect, it } from "vitest";
import {
  documentsKeys,
  mediaKeys,
  parseSimMediaKey,
  parseSimMediaRef,
  parseUploadKey,
  seedKeys,
  simMediaRef,
  uploadsKeys,
  worldKey,
} from "./document-keys";

const SHA = "3f7a9c0e".padEnd(64, "0");
const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("Documents keys (docs/architecture.md §6)", () => {
  it("versions, quarantine and unrecognized documents", () => {
    expect(documentsKeys.version("op-4471", "PACKING_LIST", 2, SHA)).toBe("ops/op-4471/PACKING_LIST/v002-3f7a9c0e.pdf");
    expect(documentsKeys.quarantine("op-4471", "msg-01J9ZQX", 1)).toBe("quarantine/op-4471/msg-01J9ZQX/1.pdf");
    expect(documentsKeys.unrecognized("op-4477", "dv-4477-CI-1")).toBe("unrecognized/op-4477/dv-4477-CI-1.pdf");
  });

  it("never takes a slash, a relative segment or a non-hex digest", () => {
    expect(() => documentsKeys.quarantine("op-4471/../x", "msg-1", 1)).toThrow(RangeError);
    expect(() => documentsKeys.unrecognized("..", "dv-4477-CI-1")).toThrow(RangeError);
    expect(() => documentsKeys.version("op-4471", "PACKING_LIST", 1, "not-a-sha")).toThrow(RangeError);
  });

  it("QA worlds prefix every key with qa/<runId>/", () => {
    expect(worldKey(documentsKeys.unrecognized("op-7001", "dv-7001-CI-1"), "812-1")).toBe("qa/812-1/unrecognized/op-7001/dv-7001-CI-1.pdf");
    expect(worldKey("uploads/t/x.pdf")).toBe("uploads/t/x.pdf");
    expect(() => worldKey("uploads/t/x.pdf", "a/b")).toThrow(RangeError);
  });
});

describe("Uploads keys", () => {
  it("build and parse the key of a pre-signed POST", () => {
    const key = uploadsKeys.object("tOk3n_-x", "CERTIFICATE_OF_ORIGIN", UUID);
    expect(key).toBe(`uploads/tOk3n_-x/CERTIFICATE_OF_ORIGIN/${UUID}.pdf`);
    expect(key.startsWith(uploadsKeys.linkPrefix("tOk3n_-x"))).toBe(true);
    expect(parseUploadKey(key)).toEqual({ token: "tOk3n_-x", docType: "CERTIFICATE_OF_ORIGIN", uuid: UUID });
    expect(parseUploadKey(worldKey(key, "812-1"))).toEqual({ qaRunId: "812-1", token: "tOk3n_-x", docType: "CERTIFICATE_OF_ORIGIN", uuid: UUID });
    expect(() => uploadsKeys.object("tok", "PACKING_LIST", "not-a-uuid")).toThrow(RangeError);
  });

  it("parses nothing that is not exactly an upload of a document type", () => {
    for (const key of [
      `uploads/tok/BILL_OF_LADING/${UUID}.pdf`,
      `uploads/tok/PACKING_LIST/${UUID}.exe`,
      `uploads/tok/extra/PACKING_LIST/${UUID}.pdf`,
      `media/tok/PACKING_LIST/${UUID}.pdf`,
      `qa/uploads/tok/PACKING_LIST/${UUID}.pdf`,
    ]) {
      expect(parseUploadKey(key), key).toBeUndefined();
    }
  });
});

describe("Media keys and the phone simulator reference", () => {
  it("live WhatsApp media and simulator attachments", () => {
    expect(mediaKeys.whatsapp("wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFjNFQjA=", "1234567890")).toBe("wa/wamid.HBgNNTQ5MTE1NTUwMDEwMRUCABIYFjNFQjA=/1234567890");
    expect(mediaKeys.simulator("msg-01J9ZQX", 1)).toBe("sim/msg-01J9ZQX/1.pdf");
    expect(parseSimMediaKey("sim/msg-01J9ZQX/1.pdf")).toEqual({ messageId: "msg-01J9ZQX", index: 1 });
    expect(parseSimMediaKey("qa/812-1/sim/msg-01J9ZQX/2.pdf")).toEqual({ qaRunId: "812-1", messageId: "msg-01J9ZQX", index: 2 });
    expect(parseSimMediaKey("wa/wamid.X/123")).toBeUndefined();
  });

  it("sim-media: references resolve only to simulator keys", () => {
    const key = mediaKeys.simulator("msg-01J9ZQX", 1);
    expect(simMediaRef(key)).toBe(`sim-media:${key}`);
    expect(parseSimMediaRef(simMediaRef(key))).toBe(key);
    expect(parseSimMediaRef("sim-media:wa/wamid.X/123")).toBeUndefined();
    expect(parseSimMediaRef("sim-media:../Documents/ops/op-4471/x.pdf")).toBeUndefined();
    expect(parseSimMediaRef("1234567890")).toBeUndefined();
    expect(() => simMediaRef("uploads/tok/x.pdf")).toThrow(RangeError);
  });
});

describe("Seed keys (docs/seed-spec.md §1)", () => {
  it("PDFs of model operations, unknown PDFs, world templates and fixed objects", () => {
    expect(seedKeys.pdf("op-4471", "PACKING_LIST", 1)).toBe("pdfs/op-4471/PACKING_LIST-v1.pdf");
    expect(seedKeys.unknownPdf(3)).toBe("pdfs/unknown/3.pdf");
    expect(seedKeys.worldTemplate("judge")).toBe("worlds/judge.json");
    expect(seedKeys.readerCatalog).toBe("reader/catalog.json");
    expect(seedKeys.batchInputs).toBe("metrics/batch-inputs.jsonl");
  });
});
