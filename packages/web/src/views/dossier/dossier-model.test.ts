import { describe, expect, it } from "vitest";
import { actionRequest } from "./api";
import {
  approveGate,
  composerMode,
  differsFromMatrix,
  documentCards,
  needsStepUp,
  outstandingOf,
  reopenGate,
  whatsappWindowOpen,
} from "./dossier-model";
import { RISK_WINDOW_HOURS, riskOf } from "./risk";
import type { DocumentData, MessageData, ObservationData, TimelineEntryData, VersionData } from "./types";

const AT = "2026-10-15T22:10:00-03:00";

function version(docType: VersionData["docType"], versionNo: number, state: VersionData["state"] = "READ"): VersionData {
  const short = { COMMERCIAL_INVOICE: "CI", PACKING_LIST: "PL", CERTIFICATE_OF_ORIGIN: "CO" }[docType];
  return {
    docVersionId: `dv-4471-${short}-${versionNo}`,
    docType,
    versionNo,
    state,
    sizeBytes: 48_000,
    receivedAtSim: AT,
    source: { party: "SUPPLIER", channel: "EMAIL" },
  };
}

function observation(overrides: Partial<ObservationData> & Pick<ObservationData, "observationId">): ObservationData {
  return {
    docType: "PACKING_LIST",
    code: "GROSS_WEIGHT_MISMATCH",
    severity: "BLOCKING",
    status: "CORRECTION_REQUESTED",
    attempts: 1,
    flaggedForReview: false,
    ...overrides,
  };
}

function document(docType: DocumentData["docType"], status: DocumentData["status"], responsibleParty?: DocumentData["responsibleParty"]): DocumentData {
  return { docType, status, currentVersion: 0, ...(responsibleParty ? { responsibleParty } : {}) };
}

function message(overrides: Partial<MessageData> & Pick<MessageData, "messageId" | "sentAtSim">): TimelineEntryData {
  const full: MessageData = {
    direction: "IN",
    channel: "WHATSAPP",
    counterpart: "IMPORTER",
    author: "IMPORTER",
    status: "RECEIVED",
    body: "Los manda el proveedor",
    to: "simulated",
    from: "+54*******0101",
    buttons: [],
    attachments: [],
    ...overrides,
  };
  return { type: "MESSAGE", atSim: full.sentAtSim, message: full };
}

describe("documents of the dossier", () => {
  const dossier = {
    documents: [document("PACKING_LIST", "WITH_OBSERVATION", "SUPPLIER"), document("COMMERCIAL_INVOICE", "VALID")],
    versions: [version("PACKING_LIST", 1), version("PACKING_LIST", 2), version("CERTIFICATE_OF_ORIGIN", 1, "UNRECOGNIZED")],
    observations: [
      observation({ observationId: "obs-4471-PL-PACKAGES_MISMATCH", code: "PACKAGES_MISMATCH", severity: "WARNING", status: "OPEN" }),
      observation({ observationId: "obs-4471-PL-NET_WEIGHT_MISMATCH", code: "NET_WEIGHT_MISMATCH", status: "RESOLVED" }),
      observation({ observationId: "obs-4471-PL-GROSS_WEIGHT_MISMATCH", responsibleParty: "SUPPLIER" }),
    ],
  };

  it("lists the three documents in the dossier's order, a missing one as faltante, versions newest first", () => {
    const cards = documentCards(dossier);
    expect(cards.map((card) => [card.docType, card.status])).toEqual([
      ["COMMERCIAL_INVOICE", "VALID"],
      ["PACKING_LIST", "WITH_OBSERVATION"],
      ["CERTIFICATE_OF_ORIGIN", "MISSING"],
    ]);
    expect(cards[1]?.versions.map((item) => item.versionNo)).toEqual([2, 1]);
  });

  it("puts open blocking observations first and picks the versions the reader did not recognize", () => {
    const [, packingList, certificate] = documentCards(dossier);
    expect(packingList?.observations.map((item) => item.code)).toEqual(["GROSS_WEIGHT_MISMATCH", "PACKAGES_MISMATCH", "NET_WEIGHT_MISMATCH"]);
    expect(certificate?.unrecognized.map((item) => item.docVersionId)).toEqual(["dv-4471-CO-1"]);
    expect(packingList?.unrecognized).toEqual([]);
  });

  it("says what is missing and who owes it: the party of an open observation, else the document's responsible", () => {
    expect(outstandingOf(dossier)).toEqual([
      { docType: "PACKING_LIST", status: "WITH_OBSERVATION", owedBy: "SUPPLIER" },
      { docType: "CERTIFICATE_OF_ORIGIN", status: "MISSING", owedBy: undefined },
    ]);
  });

  it("marks an assignment that differs from the firm's matrix for review (FL-042)", () => {
    expect(differsFromMatrix({ flaggedForReview: true })).toBe(true);
    expect(differsFromMatrix({ flaggedForReview: false, responsibleParty: "IMPORTER", matrixDefault: "SUPPLIER" })).toBe(true);
    expect(differsFromMatrix({ flaggedForReview: false, responsibleParty: "SUPPLIER", matrixDefault: "SUPPLIER" })).toBe(false);
    expect(differsFromMatrix({ flaggedForReview: false, responsibleParty: "IMPORTER", matrixDefault: "SENDER" })).toBe(false);
  });
});

describe("approving and reopening (ADR-0010)", () => {
  it("shows 'Aprobar legajo' only to BROKER and GUEST, open once the dossier is ready for review", () => {
    expect(approveGate("BROKER", "READY_FOR_REVIEW")).toEqual({ visible: true, enabled: true });
    expect(approveGate("GUEST", "READY_FOR_REVIEW")).toEqual({ visible: true, enabled: true });
    expect(approveGate("BROKER", "OPEN")).toEqual({ visible: true, enabled: false, reason: "NOT_READY" });
    expect(approveGate("ANALYST", "READY_FOR_REVIEW")).toEqual({ visible: false });
    expect(approveGate("BROKER", "APPROVED")).toEqual({ visible: false });
    expect(approveGate(undefined, "READY_FOR_REVIEW")).toEqual({ visible: false });
  });

  it("offers reopening only an approved dossier, and only to BROKER and GUEST", () => {
    expect(reopenGate("BROKER", "APPROVED")).toEqual({ visible: true, enabled: true });
    expect(reopenGate("GUEST", "APPROVED")).toEqual({ visible: true, enabled: true });
    expect(reopenGate("ANALYST", "APPROVED")).toEqual({ visible: false });
    expect(reopenGate("BROKER", "READY_FOR_REVIEW")).toEqual({ visible: false });
  });

  it("asks for the password again when the sign-in is older than 15 minutes, a minute early", () => {
    const now = Date.parse("2026-09-26T15:00:00.000Z");
    const minutesAgo = (minutes: number) => now - minutes * 60_000;
    expect(needsStepUp(minutesAgo(5), now)).toBe(false);
    expect(needsStepUp(minutesAgo(13), now)).toBe(false);
    expect(needsStepUp(minutesAgo(14), now)).toBe(true);
    expect(needsStepUp(minutesAgo(20), now)).toBe(true);
    expect(needsStepUp(undefined, now)).toBe(true);
  });
});

describe("writing to the importer", () => {
  const simNow = "2026-10-16T09:00:00-03:00";

  it("opens the 24-hour window only with a WhatsApp message of the importer, on the simulated clock", () => {
    expect(whatsappWindowOpen([message({ messageId: "msg-in", sentAtSim: "2026-10-15T10:05:00-03:00" })], simNow)).toBe(true);
    expect(whatsappWindowOpen([message({ messageId: "msg-in", sentAtSim: "2026-10-15T08:59:00-03:00" })], simNow)).toBe(false);
    expect(whatsappWindowOpen([message({ messageId: "msg-out", sentAtSim: "2026-10-16T08:00:00-03:00", direction: "OUT", author: "AGENT", status: "SENT" })], simNow)).toBe(false);
    expect(whatsappWindowOpen([message({ messageId: "msg-mail", sentAtSim: "2026-10-16T08:00:00-03:00", channel: "EMAIL", counterpart: "SUPPLIER" })], simNow)).toBe(false);
    expect(whatsappWindowOpen([message({ messageId: "msg-in", sentAtSim: "2026-10-15T10:05:00-03:00" })], undefined)).toBe(false);
  });

  it("asks to take the conversation first, keeps an approved dossier to its notices, and offers templates outside the window", () => {
    expect(composerMode("AGENT", "OPEN", true)).toBe("TAKE_FIRST");
    expect(composerMode("BROKER", "APPROVED", true)).toBe("APPROVED_SCOPE");
    expect(composerMode("BROKER", "OPEN", true)).toBe("FREE_TEXT");
    expect(composerMode("BROKER", "REOPENED", false)).toBe("TEMPLATE_ONLY");
  });
});

describe("actions of the dossier as the BFF gets them", () => {
  it("names the procedure of each action and validates its ids before they leave the browser", () => {
    expect(actionRequest({ type: "approve", operationId: "op-4471" })).toEqual({ path: "dossier.approve", input: { operationId: "op-4471" } });
    expect(actionRequest({ type: "take", operationId: "op-4471" })).toEqual({ path: "conversation.take", input: { operationId: "op-4471" } });
    expect(actionRequest({ type: "sendTemplate", operationId: "op-4471", template: "legajo_escalado" })).toEqual({ path: "conversation.send", input: { operationId: "op-4471", template: "legajo_escalado" } });
    expect(actionRequest({ type: "discard", operationId: "op-4477", docVersionId: "dv-4477-CO-1" })).toEqual({
      path: "dossier.classifyDocument",
      input: { operationId: "op-4477", docVersionId: "dv-4477-CO-1", outcome: "DISCARD" },
    });
    expect(() => actionRequest({ type: "approve", operationId: "4471" })).toThrow();
    expect(() => actionRequest({ type: "waive", operationId: "op-4471", observationId: "obs 1", reason: "x" })).toThrow();
  });
});

describe("risk on the simulated clock", () => {
  const open = { dossierStatus: "OPEN" as const, documents: [{ status: "VALID" as const }, { status: "MISSING" as const }, { status: "VALID" as const }], eta: "2026-10-22T08:00:00-03:00" };

  it("is at risk from 72 hours before the ETA while documents are missing", () => {
    const threshold = new Date(Date.parse(open.eta) - RISK_WINDOW_HOURS * 3_600_000).toISOString();
    expect(riskOf(open, threshold)).toBe("AT_RISK");
    expect(riskOf(open, new Date(Date.parse(threshold) - 60_000).toISOString())).toBe("ON_TRACK");
    expect(riskOf({ ...open, dossierStatus: "READY_FOR_REVIEW" }, threshold)).toBe("COMPLETE");
  });
});
