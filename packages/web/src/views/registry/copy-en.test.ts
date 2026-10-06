import { afterEach, describe, expect, it } from "vitest";
import { setActiveLang } from "../../lib/console-lang";
import { MILESTONE_OPTIONS } from "../clock/clock-model";
import { MILESTONE_LABELS, clockCopy } from "../clock/copy";
import { mailboxCopy } from "../mailbox/copy";
import { metricsCopy } from "../metrics/copy";
import { simulatorCopy } from "../simulator/copy";
import { BEHAVIOUR_LABELS, LANGUAGE_LABELS, registryCopy } from "./copy";

afterEach(() => setActiveLang("es"));

describe("registry, simulator, mailbox, metrics and clock texts", () => {
  it("are in Spanish by default", () => {
    expect(registryCopy.consent.granted("14/10", "Email", "v1")).toBe("Vigente desde 14/10 · Email · texto v1");
    expect(BEHAVIOUR_LABELS.NEVER).toBe("No responde");
    expect(LANGUAGE_LABELS.en).toBe("Inglés");
    expect(simulatorCopy.threads.unread(2)).toBe("2 mensajes sin leer");
    expect(mailboxCopy.supplierMailbox("X")).toBe("Proveedor: X");
    expect(metricsCopy.summary(1, "medido")).toBe("N = 1 legajo · medido");
    expect(clockCopy.now.running("11:02")).toBe("En vivo hasta las 11:02");
    expect(MILESTONE_LABELS.ARRIVAL).toBe("Arribo (ETA)");
  });

  it("follow the console's language once it is English", () => {
    setActiveLang("en");
    expect(registryCopy.consent.granted("14 Oct", "Email", "v1")).toBe("In force since 14 Oct · Email · text v1");
    expect(BEHAVIOUR_LABELS.NEVER).toBe("Does not reply");
    expect(LANGUAGE_LABELS.en).toBe("English");
    expect(simulatorCopy.threads.unread(2)).toBe("2 unread messages");
    expect(simulatorCopy.phone.gloss).toBe("EN");
    expect(mailboxCopy.supplierMailbox("X")).toBe("Supplier: X");
    expect(metricsCopy.summary(1, "measured")).toBe("N = 1 dossier · measured");
    expect(metricsCopy.labels.ASSUMPTION).toBe("assumption");
    expect(clockCopy.now.running("11:02")).toBe("Live until 11:02");
    expect(MILESTONE_LABELS.ARRIVAL).toBe("Arrival (ETA)");
  });

  it("keep option labels built at import time in the active language", () => {
    const arrival = MILESTONE_OPTIONS.find((option) => option.value === "ARRIVAL");
    expect(arrival?.label).toBe("Arribo (ETA)");
    setActiveLang("en");
    expect(arrival?.label).toBe("Arrival (ETA)");
  });
});
