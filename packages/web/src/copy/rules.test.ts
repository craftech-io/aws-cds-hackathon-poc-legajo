import { RuleId } from "@legajo/shared";
import { afterEach, describe, expect, it } from "vitest";
import { setActiveLang } from "../lib/console-lang";
import { ruleFamilyOf, ruleLabel } from "./rules";

function expectDistinctLabels(): void {
  const seen = new Map<string, string>();
  for (const id of RuleId.options) {
    const label = ruleLabel(id);
    expect(label, id).not.toBe(id);
    expect(label, id).not.toMatch(/[A-Z]{2,}-/);
    const key = `${ruleFamilyOf(id)}:${label}`;
    expect(seen.get(key), `${id} repeats the label of ${seen.get(key) ?? ""}`).toBeUndefined();
    seen.set(key, id);
  }
}

describe("rule labels of the console", () => {
  afterEach(() => setActiveLang("es"));

  it("names every rule id in words and never repeats a label inside a family", () => {
    expectDistinctLabels();
  });

  it("colours rules by family", () => {
    expect(ruleFamilyOf("CP-HOURS-SUPPLIER")).toBe("policy");
    expect(ruleFamilyOf("CED-NO-APPROVE")).toBe("cedar");
    expect(ruleFamilyOf("LAM-OP-SCOPE")).toBe("lambda");
    expect(ruleFamilyOf("G1")).toBe("other");
    expect(ruleLabel("CED-PERMIT-MESSAGING")).toBe("Tools de mensajería permitidas");
    expect(ruleLabel("CED-SESSION-HANDOFF")).toBe("Sesión obligatoria en traspaso");
  });

  it("reads in English when the console is in English, with the landing's wording", () => {
    setActiveLang("en");
    expectDistinctLabels();
    expect(ruleLabel("CP-HOURS-SUPPLIER")).toBe("Supplier's hours");
    expect(ruleLabel("CED-NO-APPROVE")).toBe("The agent does not approve");
    expect(ruleLabel("CED-PERMIT-MESSAGING")).toBe("Allowed messaging tools");
    expect(ruleLabel("CED-SESSION-HANDOFF")).toBe("Session required for handoff tools");
    setActiveLang("es");
    expect(ruleLabel("CP-HOURS-SUPPLIER")).toBe("Horario del proveedor");
  });
});
