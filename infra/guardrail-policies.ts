// Content of the two Bedrock Guardrails (docs/design-brief.md §5.5, docs/architecture.md §9.1 and
// §9.4), as plain data:
//
//   G1  the worker's pre-filter (`ApplyGuardrail`, source INPUT, over the untrusted text the normalizer
//       already masked) and the Harness `guardrailConfig` (model input and output): five denied topics,
//       prompt attack HIGH and PII.
//   G2  the outbound pipeline (`ApplyGuardrail`, source OUTPUT) over every free text of the agent:
//       contextual grounding 0.5 against the turn's tool results plus the checklist, relevance 0.5
//       (the pipeline enforces it on REPLY only) and G1's denied topics on output.
//
// Only three G1 findings may block a turn: a denied topic, PROMPT_ATTACK and a card number. The worker
// maps each to an escalation reason (docs/architecture.md §9.1), so G1 carries no other content filter
// and no word filter: any other BLOCKED would be a block nobody can classify. The Argentine document
// numbers (CUIT/CUIL, DNI, CBU/CVU) are ANONYMIZE, input only, and never block: the normalizer masked
// them already with the very same regexes, imported from packages/bff/src/lib/mask.ts (never copied),
// so G1 is the second layer. Emails and phones are NONE: registered contacts are legitimate data.
//
// Topic definitions and examples are in Spanish and English because importers write Spanish and
// suppliers English; the CLASSIC tier covers both. The FL-047 triggers are examples of their topic.
// No SST dependency: infra/guardrail.ts turns this into resources and guardrail-policies.test.ts
// checks it without an AWS account.
import { createHash } from "node:crypto";
import { GUARDRAIL_REGEXES } from "../packages/bff/src/lib/mask";

export interface DeniedTopic {
  /** `[0-9a-zA-Z-_ !?.]+`, at most 100 characters; the audit names the topic that intervened. */
  readonly name: string;
  /** At most 200 characters (CLASSIC tier). */
  readonly definition: string;
  /** At most 5 in total, 100 characters each; both languages the channels speak. */
  readonly examples: { readonly es: readonly string[]; readonly en: readonly string[] };
}

/** Denied topics of G1 (input and output) and of G2 (output). Every block of one escalates OUT_OF_CHECKLIST. */
export const DENIED_TOPICS: readonly DeniedTopic[] = [
  {
    name: "TariffClassification",
    definition:
      "Pedidos de determinar la posición arancelaria, el NCM o el código HS de una mercadería (tariff classification: which HS code or tariff heading applies to goods).",
    examples: {
      es: ["¿Qué posición arancelaria le corresponde a esto?", "¿En qué NCM tengo que declarar esta mercadería?", "¿Cuál es el código arancelario de los tejidos que importo?"],
      en: ["Which HS code should we use for these goods?", "What tariff heading applies to this product of ours?"],
    },
  },
  {
    name: "CustomsValuation",
    definition:
      "Pedidos de decidir o ajustar el valor en aduana que se declara de una mercadería (customs valuation: what value to declare to customs or how to lower it).",
    examples: {
      es: ["¿Qué valor declaro en aduana?", "¿Puedo declarar un valor más bajo que el de la factura?", "¿Con qué valor en aduana conviene presentar la mercadería?"],
      en: ["What customs value should we declare for this shipment?", "Can we declare a lower value than the invoice to pay less?"],
    },
  },
  {
    name: "DutiesAndTaxes",
    definition:
      "Cálculo, liquidación o pago de derechos de importación, IVA, tasas y demás tributos (duties and taxes: how much import duty or tax is due and how to pay it).",
    examples: {
      es: ["¿Cuánto voy a pagar de impuestos?", "¿Cuánto es el IVA y los derechos de importación de esta operación?", "¿Cómo pago los tributos de la importación?"],
      en: ["How much import duty will I have to pay for this shipment?", "Calculate the taxes due for this shipment."],
    },
  },
  {
    name: "DebtCollection",
    definition:
      "Reclamar, exigir o gestionar el cobro de una deuda, un reembolso o un pago entre las partes (debt collection: chasing a party for money it owes).",
    examples: {
      es: ["Decile al proveedor que me devuelva la plata", "Reclamale al importador lo que nos debe", "Cobrale al importador los honorarios que nos debe"],
      en: ["Tell the importer to pay what he owes us.", "Chase the supplier for the refund they owe us."],
    },
  },
  {
    name: "LegalOrCustomsAdvice",
    definition:
      "Asesoramiento legal o aduanero: qué régimen, destinación o estrategia conviene, derechos, sanciones o reclamos (legal or customs advice on regimes, penalties or claims).",
    examples: {
      es: ["¿Me conviene hacer el despacho a plaza o en depósito?", "¿Puedo iniciarle un reclamo legal al proveedor por la demora?", "¿Qué sanción me corresponde si el certificado llega tarde?"],
      en: ["Which customs regime is the best option for this import?", "Can I sue the supplier for sending the documents late?"],
    },
  },
];

export type FilterStrength = "NONE" | "LOW" | "MEDIUM" | "HIGH";

export interface ContentFilter {
  readonly type: "PROMPT_ATTACK";
  readonly inputStrength: FilterStrength;
  readonly outputStrength: FilterStrength;
}

/** Content filters of G1: prompt attack only. It exists on input only, so its output strength is NONE. */
export const CONTENT_FILTERS: readonly ContentFilter[] = [{ type: "PROMPT_ATTACK", inputStrength: "HIGH", outputStrength: "NONE" }];

export type PiiAction = "BLOCK" | "ANONYMIZE" | "NONE";

export interface PiiEntity {
  readonly type: "CREDIT_DEBIT_CARD_NUMBER" | "EMAIL" | "PHONE";
  readonly inputAction: PiiAction;
  readonly outputAction: PiiAction;
}

/**
 * Managed PII types of G1. A card number blocks (the worker escalates OTHER "datos de tarjeta"), on
 * input as the design asks and on the model's output as well, where no card can ever be legitimate.
 * Emails and phones are detected and left alone (NONE): registered contacts are part of the work.
 */
export const PII_ENTITIES: readonly PiiEntity[] = [
  { type: "CREDIT_DEBIT_CARD_NUMBER", inputAction: "BLOCK", outputAction: "BLOCK" },
  { type: "EMAIL", inputAction: "NONE", outputAction: "NONE" },
  { type: "PHONE", inputAction: "NONE", outputAction: "NONE" },
];

/** The G1 regexes are exactly mask.ts's `GUARDRAIL_REGEXES` (CUIT/CUIL, DNI, CBU/CVU): same objects, no copy. */
export const G1_REGEXES = GUARDRAIL_REGEXES;

export interface GroundingFilter {
  readonly type: "GROUNDING" | "RELEVANCE";
  readonly threshold: number;
}

/** Contextual grounding of G2. A text below either threshold does not leave (`GROUNDING_FAIL`). */
export const GROUNDING_FILTERS: readonly GroundingFilter[] = [
  { type: "GROUNDING", threshold: 0.5 },
  { type: "RELEVANCE", threshold: 0.5 },
];

/**
 * What the outbound pipeline may hand G2 in one `ApplyGuardrail` (docs/architecture.md §9.4): the query
 * built by code (the importer's question, for a REPLY), the grounding source (`Runtime/TURN#` results
 * plus the checklist) and the guarded content. Longer inputs are truncated by the pipeline first.
 */
export const G2_LIMITS = {
  queryMaxChars: 1_000,
  groundingSourceMaxChars: 100_000,
  contentMaxChars: 5_000,
} as const;

/** Tier of the topic and content policies; CLASSIC covers Spanish and English and needs no cross-region profile. */
export const GUARDRAIL_TIER = "CLASSIC";

/**
 * What Bedrock returns instead of a blocked text. It never reaches a channel: the worker and the
 * pipeline detect the block and act on its assessment (a fixed reply from packages/bff/src/copy/, an
 * escalation or `GROUNDING_FAIL`). A token and not a sentence, so a leak is caught by the outbound
 * language check and is recognisable in any log.
 */
export const BLOCKED_MESSAGES = {
  g1Input: "LEGAJO_GUARDRAIL_G1_INPUT_BLOCKED",
  g1Output: "LEGAJO_GUARDRAIL_G1_OUTPUT_BLOCKED",
  g2Input: "LEGAJO_GUARDRAIL_G2_INPUT_BLOCKED",
  g2Output: "LEGAJO_GUARDRAIL_G2_OUTPUT_BLOCKED",
} as const;

// ---- Provider-shaped configuration (aws.bedrock.GuardrailArgs), built here so the test sees exactly
// what infra/guardrail.ts sends. Arrays stay mutable because the provider's input types are. -------

interface TierConfig {
  tierName: string;
}

interface TopicPolicyConfig {
  tierConfigs: TierConfig[];
  topicsConfigs: { name: string; definition: string; examples: string[]; type: "DENY" }[];
}

interface ContentPolicyConfig {
  tierConfigs: TierConfig[];
  filtersConfigs: { type: string; inputStrength: FilterStrength; outputStrength: FilterStrength; inputModalities: string[]; outputModalities: string[] }[];
}

interface SensitiveSide {
  action: PiiAction;
  inputAction: PiiAction;
  inputEnabled: boolean;
  outputAction: PiiAction;
  outputEnabled: boolean;
}

interface SensitiveInformationPolicyConfig {
  piiEntitiesConfigs: (SensitiveSide & { type: string })[];
  regexesConfigs: (SensitiveSide & { name: string; description: string; pattern: string })[];
}

export interface GuardrailPolicyConfig {
  topicPolicyConfig?: TopicPolicyConfig;
  contentPolicyConfig?: ContentPolicyConfig;
  sensitiveInformationPolicyConfig?: SensitiveInformationPolicyConfig;
  contextualGroundingPolicyConfig?: { filtersConfigs: { type: string; threshold: number }[] };
}

const topicPolicyConfig: TopicPolicyConfig = {
  tierConfigs: [{ tierName: GUARDRAIL_TIER }],
  topicsConfigs: DENIED_TOPICS.map((topic) => ({
    name: topic.name,
    definition: topic.definition,
    examples: [...topic.examples.es, ...topic.examples.en],
    type: "DENY",
  })),
};

/** G1: denied topics, prompt attack, cards blocked, document numbers anonymized on input, contacts left alone. */
export const G1_POLICIES: GuardrailPolicyConfig = {
  topicPolicyConfig,
  contentPolicyConfig: {
    tierConfigs: [{ tierName: GUARDRAIL_TIER }],
    filtersConfigs: CONTENT_FILTERS.map((filter) => ({
      type: filter.type,
      inputStrength: filter.inputStrength,
      outputStrength: filter.outputStrength,
      inputModalities: ["TEXT"],
      outputModalities: ["TEXT"],
    })),
  },
  sensitiveInformationPolicyConfig: {
    piiEntitiesConfigs: PII_ENTITIES.map((entity) => ({
      type: entity.type,
      // `action` is the legacy single-side field the API still requires; it mirrors the input side.
      action: entity.inputAction,
      inputAction: entity.inputAction,
      inputEnabled: true,
      outputAction: entity.outputAction,
      outputEnabled: true,
    })),
    regexesConfigs: G1_REGEXES.map((regex) => ({
      name: regex.name,
      description: regex.description,
      pattern: regex.pattern,
      action: "ANONYMIZE",
      inputAction: "ANONYMIZE",
      inputEnabled: true,
      outputAction: "NONE",
      outputEnabled: false,
    })),
  },
};

/** G2: contextual grounding and relevance, plus G1's denied topics evaluated on the outbound text. */
export const G2_POLICIES: GuardrailPolicyConfig = {
  topicPolicyConfig,
  contextualGroundingPolicyConfig: { filtersConfigs: GROUNDING_FILTERS.map((filter) => ({ ...filter })) },
};

/**
 * Digest of a guardrail's policies. `aws.bedrock.GuardrailVersion` has no updatable field, so the
 * digest goes in its description: any policy change replaces the version and publishes a new number
 * on the same deploy.
 */
export function policiesDigest(policies: GuardrailPolicyConfig): string {
  return createHash("sha256").update(JSON.stringify(policies)).digest("hex").slice(0, 16);
}
