import { describe, expect, it } from "vitest";
import { z } from "zod";
import * as caller from "./caller";
import * as clockIds from "./clock-ids";
import * as documentKeys from "./document-keys";
import * as core from "./enums";
import * as dossier from "./enums-dossier";
import * as messaging from "./enums-messaging";
import * as runtime from "./enums-runtime";
import * as flows from "./flows";
import * as rules from "./rules";
import { columnTokens, jsonBlockAfter, pipeList, readDoc, tokensBetween } from "./testing";
import * as tools from "./tools";

function enumOptions(module: Record<string, unknown>): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const [name, value] of Object.entries(module)) {
    if (value instanceof z.ZodEnum) out[name] = value.options.map(String);
  }
  return out;
}

const TOOL_CATALOG = readDoc("docs/tool-catalog.md");
const CONTEXT = readDoc("CONTEXT.md");
const BRIEF = readDoc("docs/design-brief.md");
const ARCHITECTURE = readDoc("docs/architecture.md");
const INTEGRATIONS = readDoc("docs/architecture-integrations.md");

// The snapshot is the contract: a change here must be a deliberate change of the catalog.
describe("enum snapshots", () => {
  it("core enums", () => expect(enumOptions(core)).toMatchSnapshot());
  it("dossier enums", () => expect(enumOptions(dossier)).toMatchSnapshot());
  it("messaging enums", () => expect(enumOptions(messaging)).toMatchSnapshot());
  it("runtime enums", () => expect(enumOptions(runtime)).toMatchSnapshot());
  it("tools, rules, callers, clocks, keys and flows", () => {
    expect({
      ...enumOptions(tools),
      ...enumOptions(rules),
      ...enumOptions(caller),
      ...enumOptions(clockIds),
      ...enumOptions(documentKeys),
      ...enumOptions(flows),
    }).toMatchSnapshot();
  });
});

describe("docs/tool-catalog.md, Tipos compartidos", () => {
  const shared = jsonBlockAfter(TOOL_CATALOG, "Tipos compartidos") as Record<string, unknown>;
  const byName: Record<string, z.ZodEnum> = {
    DocType: dossier.DocType,
    DocStatus: dossier.DocStatus,
    Party: dossier.Party,
    DossierStatus: dossier.DossierStatus,
    ObservationStatus: dossier.ObservationStatus,
    MessageKind: messaging.MessageKind,
    WaButtonAction: messaging.WaButtonAction,
    TimerKind: runtime.TimerKind,
    ClockMode: runtime.ClockMode,
  };

  it("exports every listed enum with the same values in the same order", () => {
    const listed = Object.entries(shared).filter(([, value]) => Array.isArray(value));
    expect(listed.map(([name]) => name).sort()).toEqual(Object.keys(byName).sort());
    for (const [name, values] of listed) expect(byName[name]?.options, name).toEqual(values);
  });

  it("PolicyResult and Guardrail have the listed fields", () => {
    expect(Object.keys(rules.PolicyResult.shape).sort()).toEqual(Object.keys(shared.PolicyResult as object).map((key) => key.replace("?", "")).sort());
    expect(rules.PolicyResult.parse({ allowed: false, ruleIds: ["CP-HOURS-SUPPLIER"], nextAllowedAt: "2026-10-15T22:00:00-03:00" }).allowed).toBe(false);
    expect(rules.PolicyResult.safeParse({ allowed: true, ruleIds: ["CP-UNKNOWN"] }).success).toBe(false);
    const guardrail = shared.Guardrail as { action: string };
    expect(runtime.GuardrailOutcome.options).toEqual(guardrail.action.split(" | "));
    expect(runtime.Guardrail.safeParse({ action: "ANONYMIZED" }).success).toBe(false);
    expect(runtime.Guardrail.safeParse({ action: "BLOCKED", groundingScore: 0.4 }).success).toBe(true);
  });

  it("ErrorCode is the closed list of the conventions", () => {
    expect(core.ErrorCode.options).toEqual(tokensBetween(TOOL_CATALOG, "`code` ∈", "\n"));
  });

  it("the caller kinds of direct invocation", () => {
    expect(caller.CallerKind.options).toEqual(pipeList(TOOL_CATALOG, /\{"kind": ([^,]+), "firmId"/));
  });
});

describe("CONTEXT.md and the design docs", () => {
  it("TurnTrigger, EscalationReason and SupplierBehaviour match the glossary", () => {
    expect(runtime.TurnTrigger.options).toEqual(tokensBetween(CONTEXT, "(`TurnTrigger`:", ")."));
    expect(dossier.EscalationReason.options).toEqual(tokensBetween(CONTEXT, "(`EscalationReason`):", " (con resumen"));
    expect(messaging.SupplierBehaviour.options).toEqual(tokensBetween(CONTEXT, "(`SupplierBehaviour`:", ")."));
    expect(dossier.DocStatus.options).toEqual(tokensBetween(CONTEXT, "(`DocStatus`):", "Solo el lector"));
    expect(messaging.SupplierContactStatus.options).toEqual(tokensBetween(CONTEXT, "con estado ", ". El agente"));
  });

  it("the turn triggers and escalation reasons of the design brief tables", () => {
    // The brief lists UPLOAD_COMPLETED next to DOCUMENT_READ; the glossary order above is the enum's.
    expect([...runtime.TurnTrigger.options].sort()).toEqual(columnTokens(BRIEF, "| Disparador (`TurnTrigger`)").sort());
    expect(dossier.EscalationReason.options).toEqual(columnTokens(BRIEF, "| Motivo | Quién decide"));
    expect(dossier.AgentEscalationReason.options).toEqual(pipeList(TOOL_CATALOG, /"reason": \{"type": "string", "description": "(OUT_OF_CHECKLIST[^"]*)"\}/));
  });

  it("every message kind of the kind → channel matrix", () => {
    expect(messaging.MessageKind.options).toEqual(columnTokens(BRIEF, "| `MessageKind` | Para"));
    expect(messaging.SupplierEmailKind.options).toEqual(pipeList(TOOL_CATALOG, /"kind": \{"type": "string", "description": "(DOCS_REQUEST[^"]*)"\}/));
  });

  it("doc types, observation codes, readings and severities follow the reader contract", () => {
    const openApiEnum = (field: string): string[] | undefined =>
      new RegExp(`${field}: \\{ type: string, enum: \\[([^\\]]+)\\] \\}`).exec(INTEGRATIONS)?.[1]?.split(", ");
    expect(dossier.DocType.options).toEqual(openApiEnum("expectedDocType"));
    expect(dossier.ObservationCode.options).toEqual(openApiEnum("code"));
    expect(dossier.ReadingStatus.options).toEqual(openApiEnum("status"));
    expect(dossier.ReadingMatchedBy.options).toEqual(openApiEnum("matchedBy"));
    expect(dossier.ObservationSeverity.options).toEqual(openApiEnum("severity"));
  });

  it("supplier behaviours, templates and sender profiles of the integrations doc", () => {
    expect([...messaging.SupplierBehaviour.options].sort()).toEqual(columnTokens(INTEGRATIONS, "| Comportamiento | Respuesta").sort());
    expect(messaging.WhatsAppTemplateName.options).toEqual(columnTokens(INTEGRATIONS, "| Nombre | Cuerpo | Botones"));
    expect(core.SenderProfile.options).toEqual(columnTokens(INTEGRATIONS, "| Perfil | Quién lo usa"));
    // LEAD_NOTICE (ADR-0015 §6): its exact @craftech.io fence is tested in packages/bff/src/channels/email/fence.test.ts.
    expect(core.SenderProfile.options).toContain("LEAD_NOTICE");
  });

  it("inline enums of the tool outputs and handlers", () => {
    expect(dossier.DispatchStatus.options).toEqual(pipeList(TOOL_CATALOG, /"status": "(NONE \| OFICIALIZADO[^"]*)"/));
    expect(dossier.CustomsChannel.options).toEqual(pipeList(TOOL_CATALOG, /"channel": "(VERDE[^"]*)"/));
    expect(dossier.DocumentSourceChannel.options).toEqual(pipeList(TOOL_CATALOG, /"channel": "(EMAIL \| WHATSAPP \| UPLOAD_LINK[^"]*)"/));
    expect(dossier.ConversationControl.options).toEqual(pipeList(TOOL_CATALOG, /"control": "(AGENT[^"]*)"/));
    expect(messaging.SendStatus.options).toEqual(pipeList(TOOL_CATALOG, /"status": "(SENT[^"]*)"/));
    expect(messaging.ConsentMedium.options).toEqual(tokensBetween(TOOL_CATALOG, "medio (", ")"));
    expect(runtime.GuardrailOrigin.options).toEqual(tokensBetween(TOOL_CATALOG, "con `origin` (", ")"));
    expect(runtime.GuardrailSource.options).toEqual(tokensBetween(TOOL_CATALOG, "y `source` (", ")"));
  });

  it("tenants, metrics, pending mail and reference types of the data model", () => {
    expect(core.FirmKind.options).toEqual(tokensBetween(ARCHITECTURE, "Firm (`kind` ", ";"));
    expect(core.GuestKind.options).toEqual(tokensBetween(ARCHITECTURE, "`guestKind` ", " en los `GUEST`"));
    expect(core.MetricSource.options).toEqual(tokensBetween(ARCHITECTURE, "DossierKpi (`source` ", ", `runId`"));
    expect(core.AgentMode.options).toEqual(tokensBetween(ARCHITECTURE, "`agentMode` ", ")"));
    expect(core.MailAwaiting.options).toEqual(tokensBetween(INTEGRATIONS, "con `awaiting` ", " según"));
    const referenceTypes = columnTokens(readDoc("docs/seed-spec.md"), "| Tipo | Contenido", { firstOnly: true }).map((token) => token.split("#")[0]);
    expect(core.ReferenceType.options).toEqual(referenceTypes);
  });

  it("queue event types, timer kinds and the milestones of the architecture", () => {
    expect(runtime.OperationEventType.options).toEqual(columnTokens(ARCHITECTURE, "| Tipo | Productor | Qué hace el worker"));
    expect(runtime.TimerKind.options).toEqual(columnTokens(ARCHITECTURE, "| `kind` | Quién lo crea", { firstOnly: true }));
    expect(runtime.MilestoneName.options).toEqual(tokensBetween(CONTEXT, "es un **temporizador** de tipo `MILESTONE`:", "Cuando la ETA"));
    expect(runtime.TimerStatus.options).toEqual(pipeList(ARCHITECTURE, /status (SCHEDULED[A-Z|]+), firedBy/));
    expect(runtime.TimerFiredBy.options).toEqual(pipeList(ARCHITECTURE, /firedBy ([A-Z_|]+), version/));
    expect(runtime.PendingKind.options).toEqual(pipeList(ARCHITECTURE, /\{kind: ([A-Z |]+), operationNumber/));
    expect(runtime.AuditDecision.options).toEqual(pipeList(ARCHITECTURE, /Decision \(`decision` ([A-Z/]+),/).flatMap((value) => value.split("/")));
  });
});

describe("catalog invariants", () => {
  it("channels: CONSOLE is a channel, never a send channel", () => {
    expect(core.Channel.options).toContain("CONSOLE");
    expect(core.SendChannel.options).not.toContain("CONSOLE");
    for (const channel of core.SendChannel.options) expect(core.Channel.options).toContain(channel);
    expect(core.channelNameOf("WHATSAPP")).toBe("whatsapp");
    expect(core.channelNameOf("EMAIL")).toBe("email");
  });

  it("console roles keep their precedence and only BROKER and GUEST approve", () => {
    expect(core.ConsoleRole.options).toEqual(["BROKER", "GUEST", "ANALYST"]);
    expect(core.ConsoleRole.options.filter(core.canApprove)).toEqual(["BROKER", "GUEST"]);
  });

  it("the matrix default adds SENDER to the parties", () => {
    expect(dossier.MatrixResponsible.options).toEqual([...dossier.Party.options, "SENDER"]);
  });

  it("the guardrail outcome of a send is never ANONYMIZED", () => {
    expect(runtime.GuardrailAction.options).toContain("ANONYMIZED");
    expect(runtime.GuardrailOutcome.options).not.toContain("ANONYMIZED");
  });
});
