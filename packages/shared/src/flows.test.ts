import { describe, expect, it } from "vitest";
import { FLOW_AREAS, FlowArea, FlowId, FlowLevel, ScenarioStepRef, expandStepRef, flowTag, flowTagsIn } from "./flows";
import { readDoc, tableRows } from "./testing";

const CATALOG = readDoc("docs/flows-catalog.md");
const MATRIX = tableRows(readDoc("docs/test-plan.md"), "| Flujo | Título | U | LF | UI | SR | SMK | Notas");

describe("flow ids and tags", () => {
  it("FL-000 ids and their [FL-xxx] tags", () => {
    expect(FlowId.safeParse("FL-007").success).toBe(true);
    expect(FlowId.safeParse("FL-7").success).toBe(false);
    expect(FlowId.safeParse("F007").success).toBe(false);
    expect(flowTag("FL-007")).toBe("[FL-007]");
    expect(() => flowTag("FL-07")).toThrow();
    expect(flowTagsIn("sends the template [FL-007] [FL-065] and again [FL-007]")).toEqual(["FL-007", "FL-065"]);
    expect(flowTagsIn("no tag here")).toEqual([]);
  });

  it("scenario step references expand ranges", () => {
    expect(expandStepRef("SC-07/1..3")).toEqual(["SC-07/1", "SC-07/2", "SC-07/3"]);
    expect(expandStepRef("SMK/4")).toEqual(["SMK/4"]);
    expect(() => expandStepRef("SC-07/3..1")).toThrow(RangeError);
    expect(ScenarioStepRef.safeParse("SC-7/1").success).toBe(false);
  });
});

describe("docs/flows-catalog.md", () => {
  it("has the areas of FLOW_AREAS, in order", () => {
    const letters = [...(/^Áreas: (.+)$/m.exec(CATALOG)?.[1] ?? "").matchAll(/(?:^|· )([A-Z]) /g)].map((match) => match[1]);
    expect(letters).toEqual(FlowArea.options);
    const sections = [...CATALOG.matchAll(/^## Área ([A-Z]) · /gm)].map((match) => match[1]);
    expect(sections).toEqual(Object.keys(FLOW_AREAS));
  });

  it("numbers 133 flows FL-001 … FL-133, each under an area", () => {
    const ids = [...CATALOG.matchAll(/^### (FL-\d{3}) · /gm)].map((match) => match[1] ?? "");
    expect(ids).toEqual(Array.from({ length: 133 }, (_, index) => `FL-${String(index + 1).padStart(3, "0")}`));
    for (const id of ids) expect(FlowId.safeParse(id).success).toBe(true);
    expect(CATALOG.indexOf("## Área A")).toBeLessThan(CATALOG.indexOf("### FL-001"));
  });
});

describe("docs/test-plan.md matrix", () => {
  it("has one column per test level", () => {
    const header = readDoc("docs/test-plan.md").split("\n").find((line) => line.startsWith("| Flujo | Título"));
    expect(header?.split(" | ").slice(2, 7)).toEqual(FlowLevel.options);
  });

  it("every SR and SMK cell cites valid step references", () => {
    expect(MATRIX).toHaveLength(133);
    const refs = MATRIX.flatMap((cells) => [cells[5], cells[6]]).flatMap((cell) => [...(cell ?? "").matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? ""));
    expect(refs.length).toBeGreaterThan(100);
    expect(refs.filter((ref) => !ScenarioStepRef.safeParse(ref).success)).toEqual([]);
  });
});
