// `channels:whatsapp-templates` (docs/pending.md P-01 step 7) with the SDK behind ports: nothing runs
// before the WABA is connected, the plan writes nothing, `--apply` creates only the missing templates in
// Meta's format and records each one's id and status.
import { describe, expect, it } from "vitest";
import { TEMPLATES } from "@legajo/bff/copy/templates";
import { type TemplatesDeps, metaDefinition, parseTemplatesArgs, runTemplates, statusOf } from "./whatsapp-templates";

function deps(remote: Array<{ name: string; language: string; status?: string }> = [], wabaId: string | null = "waba-1") {
  const created: Array<Record<string, unknown>> = [];
  const recorded: Array<[string, unknown]> = [];
  const ports: TemplatesDeps = {
    list: async () => remote,
    create: async (_id, definition) => {
      created.push(definition);
      return { metaTemplateId: `meta-${String(definition.name)}`, status: "PENDING", category: "UTILITY" };
    },
    record: async (name, update) => void recorded.push([name, update]),
    wabaId: () => wabaId ?? undefined,
    report: () => undefined,
  };
  return { ports, created, recorded };
}

describe("channels:whatsapp-templates", () => {
  it("needs --stage poc and a connected WABA", async () => {
    expect(() => parseTemplatesArgs(["--apply"])).toThrow(/--stage poc/);
    await expect(runTemplates({ stage: "poc", apply: true }, deps([], null).ports)).rejects.toThrow(/P-01/);
  });

  it("plans without writing, then creates only the missing templates and records them", async () => {
    const existing = { name: "legajo_aprobado", language: "es_AR", status: "APPROVED" };
    const plan = deps([existing]);
    expect(await runTemplates(parseTemplatesArgs(["--stage", "poc"]), plan.ports)).toEqual({ created: 0, existing: 1 });
    expect(plan.created).toEqual([]);
    expect(plan.recorded).toEqual([]);
    const apply = deps([existing]);
    const total = Object.keys(TEMPLATES).length;
    expect(await runTemplates(parseTemplatesArgs(["--stage", "poc", "--apply"]), apply.ports)).toEqual({ created: total - 1, existing: 1 });
    expect(apply.created.map((definition) => definition.name)).not.toContain("legajo_aprobado");
    expect(apply.recorded).toContainEqual(["legajo_aprobado", { status: "APPROVED" }]);
    expect(apply.recorded).toContainEqual(["legajo_docs_pendientes", { metaTemplateId: "meta-legajo_docs_pendientes", status: "PENDING" }]);
  });

  it("writes Meta's definition: UTILITY es_AR, body examples and buttons", () => {
    const definition = metaDefinition(TEMPLATES.legajo_docs_pendientes);
    expect(definition).toMatchObject({ name: "legajo_docs_pendientes", language: "es_AR", category: "UTILITY" });
    const [body, buttons] = definition.components as Array<Record<string, unknown>>;
    expect(body).toMatchObject({ type: "BODY", example: { body_text: [TEMPLATES.legajo_docs_pendientes.params.map((param) => param.example)] } });
    expect(buttons).toMatchObject({ type: "BUTTONS" });
    expect((buttons?.buttons as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "URL", url: "https://legajo.demo.craftech.io/u/{{1}}" });
    expect(statusOf("approved")).toBe("APPROVED");
    expect(statusOf("IN_APPEAL")).toBe("PENDING");
  });
});
