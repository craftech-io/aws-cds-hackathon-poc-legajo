// The bitácora, the shared error texts and the rule labels follow the console's language: the same
// accessors read Spanish by default and English once the console is in English.
import { afterEach, describe, expect, it } from "vitest";
import { dataCopy } from "../../copy/console-data";
import { setActiveLang } from "../../lib/console-lang";
import { actionLabel, actorLabel, ruleOptionLabel, triggerLabel } from "./audit-model";
import { ACTION_LABELS, DECISION_FILTER_LABELS, TRIGGER_LABELS, auditCopy } from "./copy";

describe("the bitácora in the console's language", () => {
  afterEach(() => setActiveLang("es"));

  it("reads Spanish by default", () => {
    expect(auditCopy.counters.title).toBe("Resumen de la política");
    expect(DECISION_FILTER_LABELS.ALLOW).toBe("Permitidas");
    expect(TRIGGER_LABELS.MILESTONE).toBe("Hito");
    expect(ACTION_LABELS.SEND_EMAIL).toBe("Email al proveedor");
    expect(dataCopy.byKind.unauthorized).toBe("La sesión venció. Ingresá de nuevo.");
    expect(dataCopy.byReason.CROSS_FIRM).toBe("Ese dato no pertenece a tu estudio.");
    expect(ruleOptionLabel("CP-HOURS-SUPPLIER")).toBe("Horario del proveedor · CP-HOURS-SUPPLIER");
  });

  it("reads English once the console is in English", () => {
    setActiveLang("en");
    expect(auditCopy.counters.title).toBe("Policy summary");
    expect(DECISION_FILTER_LABELS.ALLOW).toBe("Allowed");
    expect(TRIGGER_LABELS.MILESTONE).toBe("Milestone");
    expect(ACTION_LABELS.SEND_EMAIL).toBe("Email to the supplier");
    expect(dataCopy.byKind.unauthorized).toBe("Your session expired. Sign in again.");
    expect(dataCopy.byReason.CROSS_FIRM).toBe("That data does not belong to your firm.");
    expect(ruleOptionLabel("CP-HOURS-SUPPLIER")).toBe("Supplier's hours · CP-HOURS-SUPPLIER");
    expect(actionLabel("CONSENT_GRANTED")).toBe("Opt-in recorded");
    expect(triggerLabel("ETA_CHANGED")).toBe("ETA change");
    expect(actorLabel("BROKER:usr-1")).toBe("Firm member");
  });

  it("keeps unknown codes as plain words and unknown reasons unset in both languages", () => {
    for (const lang of ["es", "en"] as const) {
      setActiveLang(lang);
      expect(actionLabel("SOME_NEW_ACTION")).toBe("some new action");
      expect(dataCopy.byReason.SOME_NEW_REASON).toBeUndefined();
    }
  });
});
