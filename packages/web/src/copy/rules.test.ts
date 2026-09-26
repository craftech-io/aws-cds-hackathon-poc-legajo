import { RuleId } from "@legajo/shared";
import { describe, expect, it } from "vitest";
import { ruleFamilyOf, ruleLabel } from "./rules";

describe("rule labels of the console", () => {
  it("names every rule id in words and never repeats a label inside a family", () => {
    const seen = new Map<string, string>();
    for (const id of RuleId.options) {
      const label = ruleLabel(id);
      expect(label, id).not.toBe(id);
      expect(label, id).not.toMatch(/[A-Z]{2,}-/);
      const key = `${ruleFamilyOf(id)}:${label}`;
      expect(seen.get(key), `${id} repeats the label of ${seen.get(key) ?? ""}`).toBeUndefined();
      seen.set(key, id);
    }
  });

  it("colours rules by family", () => {
    expect(ruleFamilyOf("CP-HOURS-SUPPLIER")).toBe("policy");
    expect(ruleFamilyOf("CED-NO-APPROVE")).toBe("cedar");
    expect(ruleFamilyOf("LAM-OP-SCOPE")).toBe("lambda");
    expect(ruleFamilyOf("G1")).toBe("other");
    expect(ruleLabel("CED-PERMIT-MESSAGING")).toBe("Tools de mensajería permitidas");
    expect(ruleLabel("CED-SESSION-HANDOFF")).toBe("Sesión obligatoria en traspaso");
  });
});
