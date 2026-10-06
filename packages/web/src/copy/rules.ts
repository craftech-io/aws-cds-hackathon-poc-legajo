// What each rule id means, in the words the firm reads next to it (bitácora, pendings, metrics):
// the contact policy (`CP-*`, docs/design-brief.md §5.7), the Gateway's Cedar statements (`CED-*`)
// and the Lambda fences (`LAM-*`, §5.6), the responsibility matrix and the two guardrails, in Spanish
// and English (copy/localized.ts). The English reads like the landing's guarantees. The id itself stays
// on screen: it is how the README, the flows and the audit log cite the rule.
import { type CedarStatementId, type ContactPolicyRuleId, type LambdaFenceId, type RuleId, ToolTarget } from "@legajo/shared";
import { localized, type Widen } from "./localized";

type NamedCedarId = Exclude<CedarStatementId, `CED-PERMIT-${string}` | `CED-SESSION-${string}`>;

const es = {
  contactPolicy: {
    "CP-CONTROL-BROKER": "Conversación tomada por el estudio",
    "CP-KIND-CHANNEL": "Tipo de mensaje y canal",
    "CP-RECIPIENT-FENCE": "Cerco de destinatarios",
    "CP-OPTIN": "Opt-in de WhatsApp",
    "CP-OPTOUT": "Baja de avisos",
    "CP-SUPPLIER-AUTH": "Autorización para escribir al proveedor",
    "CP-BOUNCED-CONTACT": "Contacto rebotado",
    "CP-APPROVED-SCOPE": "Legajo aprobado",
    "CP-HOURS-AR": "Horario de Argentina",
    "CP-HOURS-SUPPLIER": "Horario del proveedor",
    "CP-ONE-PER-DAY": "Un recordatorio por día",
    "CP-WA-24H": "Ventana de 24 h",
    "CP-NO-SENSITIVE-ASK": "Sin pedido de datos sensibles",
    "CP-NO-FOREIGN-LINKS": "Sin enlaces ni contactos ajenos",
    "CP-WORLD-QUOTA": "Límite de emails de la demo",
  } satisfies Record<ContactPolicyRuleId, string>,
  targets: {
    operations: "operaciones",
    documents: "documentos",
    messaging: "mensajería",
    followups: "seguimientos",
    handoff: "traspaso",
  } satisfies Record<ToolTarget, string>,
  cedar: {
    "CED-EMAIL-SUPPLIER-ONLY": "Email solo al proveedor",
    "CED-WA-IMPORTER-ONLY": "WhatsApp solo al importador",
    "CED-NO-APPROVE": "El agente no aprueba",
    "CED-RISK-ASSUMPTIONS": "Supuestos de riesgo fijos",
    "CED-KILL-SWITCH": "Agente apagado",
  } satisfies Record<NamedCedarId, string>,
  lambdaFences: {
    "LAM-STRICT": "Solo campos declarados",
    "LAM-OP-SCOPE": "Alcance de la operación",
    "LAM-RECIPIENT": "Destinatario del registro",
    "LAM-SUPPLIER-AUTH": "Autorización y contacto confirmado",
    "LAM-CONTROL": "Conversación tomada por el estudio",
    "LAM-ATTACHMENT": "Adjuntos de la misma operación",
    "LAM-TRIGGER": "Disparador del turno",
    "LAM-EVIDENCE": "Evidencia del turno",
    "LAM-CALLER": "Invocación directa",
  } satisfies Record<LambdaFenceId, string>,
  others: {
    "RESP-MATRIX": "Matriz de responsabilidad",
    G1: "Guardrail de entrada",
    G2: "Guardrail de salida",
  },
  permit: (target: string) => `Tools de ${target} permitidas`,
  session: (target: string) => `Sesión obligatoria en ${target}`,
} as const;

const en = {
  contactPolicy: {
    "CP-CONTROL-BROKER": "Conversation taken over by the firm",
    "CP-KIND-CHANNEL": "Message type and channel",
    "CP-RECIPIENT-FENCE": "Recipient fence",
    "CP-OPTIN": "WhatsApp opt-in",
    "CP-OPTOUT": "Notice opt-out",
    "CP-SUPPLIER-AUTH": "Authorization to write to the supplier",
    "CP-BOUNCED-CONTACT": "Bounced contact",
    "CP-APPROVED-SCOPE": "Dossier approved",
    "CP-HOURS-AR": "Argentina's hours",
    "CP-HOURS-SUPPLIER": "Supplier's hours",
    "CP-ONE-PER-DAY": "One reminder a day",
    "CP-WA-24H": "24-hour window",
    "CP-NO-SENSITIVE-ASK": "No requests for sensitive data",
    "CP-NO-FOREIGN-LINKS": "No outside links or contacts",
    "CP-WORLD-QUOTA": "Demo email limit",
  },
  targets: {
    operations: "operations",
    documents: "documents",
    messaging: "messaging",
    followups: "follow-up",
    handoff: "handoff",
  },
  cedar: {
    "CED-EMAIL-SUPPLIER-ONLY": "Email to the supplier only",
    "CED-WA-IMPORTER-ONLY": "WhatsApp to the importer only",
    "CED-NO-APPROVE": "The agent does not approve",
    "CED-RISK-ASSUMPTIONS": "Fixed risk assumptions",
    "CED-KILL-SWITCH": "Agent switched off",
  },
  lambdaFences: {
    "LAM-STRICT": "Declared fields only",
    "LAM-OP-SCOPE": "Operation scope",
    "LAM-RECIPIENT": "Recipient from the registry",
    "LAM-SUPPLIER-AUTH": "Authorization and confirmed contact",
    "LAM-CONTROL": "Conversation taken over by the firm",
    "LAM-ATTACHMENT": "Attachments from the same operation",
    "LAM-TRIGGER": "Turn trigger",
    "LAM-EVIDENCE": "Turn evidence",
    "LAM-CALLER": "Direct invocation",
  },
  others: {
    "RESP-MATRIX": "Responsibility matrix",
    G1: "Input guardrail",
    G2: "Output guardrail",
  },
  permit: (target: string) => `Allowed ${target} tools`,
  session: (target: string) => `Session required for ${target} tools`,
} satisfies Widen<typeof es>;

const texts: Widen<typeof es> = localized({ es, en });

/** The family of a rule, for its colour. */
export type RuleFamily = "policy" | "cedar" | "lambda" | "other";

export function ruleFamilyOf(id: RuleId): RuleFamily {
  if (id.startsWith("CP-")) return "policy";
  if (id.startsWith("CED-")) return "cedar";
  if (id.startsWith("LAM-")) return "lambda";
  return "other";
}

function targetOf(id: string, prefix: string): ToolTarget | undefined {
  const parsed = ToolTarget.safeParse(id.slice(prefix.length).toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

/** "Horario del proveedor" for `CP-HOURS-SUPPLIER`; every rule id has one, in the console's language at call time. */
export function ruleLabel(id: RuleId): string {
  if (id in texts.contactPolicy) return texts.contactPolicy[id as ContactPolicyRuleId];
  if (id in texts.cedar) return texts.cedar[id as NamedCedarId];
  if (id in texts.lambdaFences) return texts.lambdaFences[id as LambdaFenceId];
  if (id in texts.others) return texts.others[id as keyof typeof texts.others];
  const permit = targetOf(id, "CED-PERMIT-");
  if (id.startsWith("CED-PERMIT-") && permit) return texts.permit(texts.targets[permit]);
  const session = targetOf(id, "CED-SESSION-");
  if (id.startsWith("CED-SESSION-") && session) return texts.session(texts.targets[session]);
  return id;
}
