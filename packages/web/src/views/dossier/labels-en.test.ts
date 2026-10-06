import { afterEach, describe, expect, it } from "vitest";
import { setActiveLang } from "../../lib/console-lang";
import { escalationsCopy } from "../escalations/copy";
import { operationsCopy } from "../operations/copy";
import { dossierCopy } from "./copy";
import { actorLabel, docTypeLabel, timerTitle, turnTriggerText } from "./labels";

afterEach(() => {
  setActiveLang("es");
});

describe("files group texts follow the console's language", () => {
  it("reads Spanish by default", () => {
    expect(docTypeLabel.COMMERCIAL_INVOICE).toBe("Factura comercial");
    expect(timerTitle("MILESTONE", "DOCS_REQUEST")).toBe("Pedido inicial (ETA − 7 días)");
    expect(timerTitle("SIM_REPLY", "x")).toBe("Esperando respuesta del proveedor por SES");
    expect(actorLabel("BROKER:x")).toBe("Estudio");
    expect(actorLabel("UNKNOWN")).toBe("Sistema");
    expect(turnTriggerText("MILESTONE")).toBe("hito");
    expect(dossierCopy.documents.attempts(2)).toBe("2 intentos");
    expect(operationsCopy.filters.statuses.APPROVED).toBe("Aprobados");
    expect(escalationsCopy.openFor(1, 2)).toBe("hace 1 d 2 h");
  });

  it("reads English once the console switches, through the same exports", () => {
    setActiveLang("en");
    expect(docTypeLabel.COMMERCIAL_INVOICE).toBe("Commercial invoice");
    expect(timerTitle("MILESTONE", "DOCS_REQUEST")).toBe("Initial request (ETA − 7 days)");
    expect(timerTitle("SIM_REPLY", "x")).toBe("Waiting for the supplier's reply through SES");
    expect(actorLabel("BROKER:x")).toBe("Firm");
    expect(actorLabel("UNKNOWN")).toBe("System");
    expect(turnTriggerText("MILESTONE")).toBe("milestone");
    expect(turnTriggerText("NOT_A_TRIGGER")).toBe("");
    expect(dossierCopy.documents.attempts(2)).toBe("2 attempts");
    expect(dossierCopy.risk.assumptionLabel).toBe("Assumption");
    expect(operationsCopy.filters.statuses.APPROVED).toBe("Approved");
    expect(escalationsCopy.openFor(1, 2)).toBe("1 d 2 h ago");
  });

  it("keeps the keys of a record identical in both languages", () => {
    const spanishKeys = Object.keys(docTypeLabel);
    setActiveLang("en");
    expect(Object.keys(docTypeLabel)).toEqual(spanishKeys);
    expect(Object.values(docTypeLabel)).toEqual(["Commercial invoice", "Packing list", "Certificate of origin"]);
  });
});
