// "Qué es real y qué es simulado" (docs/landing-spec.md §1.9): every service or system of the demo in
// exactly one column, by id. landing.test.ts checks that the three lists do not intersect and that
// each language's sentence names exactly the ids of its column (and none of the others').
export const DEMO_COLUMNS = {
  real: ["ses", "agentcore", "guardrails", "scheduler", "sqs", "dynamodb", "s3", "cognito", "cloudfront"],
  simulatedMode: ["eum-social"],
  mocks: ["reader", "platform", "carrier", "customs", "suppliers"],
} as const;

export type DemoColumnId = keyof typeof DEMO_COLUMNS;
export type DemoItemId = (typeof DEMO_COLUMNS)[DemoColumnId][number];

/** How each language names an item in its column's sentence. */
export const DEMO_ITEM_NAMES: Readonly<Record<DemoItemId, { readonly es: string; readonly en: string }>> = {
  ses: { es: "Amazon SES", en: "Amazon SES" },
  agentcore: { es: "Amazon Bedrock AgentCore", en: "Amazon Bedrock AgentCore" },
  guardrails: { es: "Guardrails", en: "Guardrails" },
  scheduler: { es: "EventBridge Scheduler", en: "EventBridge Scheduler" },
  sqs: { es: "SQS", en: "SQS" },
  dynamodb: { es: "DynamoDB", en: "DynamoDB" },
  s3: { es: "S3", en: "S3" },
  cognito: { es: "Cognito", en: "Cognito" },
  cloudfront: { es: "CloudFront", en: "CloudFront" },
  "eum-social": { es: "AWS End User Messaging Social", en: "AWS End User Messaging Social" },
  reader: { es: "Lector documental", en: "Document reader" },
  platform: { es: "sistema de gestión aduanera", en: "customs management system" },
  carrier: { es: "transportista", en: "carrier" },
  customs: { es: "aduana", en: "customs" },
  suppliers: { es: "proveedores", en: "suppliers" },
};
