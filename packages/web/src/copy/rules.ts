// What each rule id means, in the words the firm reads next to it (bitácora, pendings, metrics):
// the contact policy (`CP-*`, docs/design-brief.md §5.7), the Gateway's Cedar statements (`CED-*`)
// and the Lambda fences (`LAM-*`, §5.6), the responsibility matrix and the two guardrails. The id
// itself stays on screen: it is how the README, the flows and the audit log cite the rule.
import { type CedarStatementId, type ContactPolicyRuleId, type LambdaFenceId, type RuleId, ToolTarget } from "@legajo/shared";

const CONTACT_POLICY: Readonly<Record<ContactPolicyRuleId, string>> = {
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
};

const TARGET_LABEL: Readonly<Record<ToolTarget, string>> = {
  operations: "operaciones",
  documents: "documentos",
  messaging: "mensajería",
  followups: "seguimientos",
  handoff: "traspaso",
};

type NamedCedarId = Exclude<CedarStatementId, `CED-PERMIT-${string}` | `CED-SESSION-${string}`>;

const CEDAR: Readonly<Record<NamedCedarId, string>> = {
  "CED-EMAIL-SUPPLIER-ONLY": "Email solo al proveedor",
  "CED-WA-IMPORTER-ONLY": "WhatsApp solo al importador",
  "CED-NO-APPROVE": "El agente no aprueba",
  "CED-RISK-ASSUMPTIONS": "Supuestos de riesgo fijos",
  "CED-KILL-SWITCH": "Agente apagado",
};

const LAMBDA_FENCES: Readonly<Record<LambdaFenceId, string>> = {
  "LAM-STRICT": "Solo campos declarados",
  "LAM-OP-SCOPE": "Alcance de la operación",
  "LAM-RECIPIENT": "Destinatario del registro",
  "LAM-SUPPLIER-AUTH": "Autorización y contacto confirmado",
  "LAM-CONTROL": "Conversación tomada por el estudio",
  "LAM-ATTACHMENT": "Adjuntos de la misma operación",
  "LAM-TRIGGER": "Disparador del turno",
  "LAM-EVIDENCE": "Evidencia del turno",
  "LAM-CALLER": "Invocación directa",
};

const OTHERS = {
  "RESP-MATRIX": "Matriz de responsabilidad",
  G1: "Guardrail de entrada",
  G2: "Guardrail de salida",
} as const;

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

/** "Horario del proveedor" for `CP-HOURS-SUPPLIER`; every rule id has one. */
export function ruleLabel(id: RuleId): string {
  if (id in CONTACT_POLICY) return CONTACT_POLICY[id as ContactPolicyRuleId];
  if (id in CEDAR) return CEDAR[id as NamedCedarId];
  if (id in LAMBDA_FENCES) return LAMBDA_FENCES[id as LambdaFenceId];
  if (id in OTHERS) return OTHERS[id as keyof typeof OTHERS];
  const permit = targetOf(id, "CED-PERMIT-");
  if (id.startsWith("CED-PERMIT-") && permit) return `Tools de ${TARGET_LABEL[permit]} permitidas`;
  const session = targetOf(id, "CED-SESSION-");
  if (id.startsWith("CED-SESSION-") && session) return `Sesión obligatoria en ${TARGET_LABEL[session]}`;
  return id;
}
