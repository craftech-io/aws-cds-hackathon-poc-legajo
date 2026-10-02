// Guardrail G2 on the way out (docs/design-brief.md §5.5, docs/architecture.md §9.4): `ApplyGuardrail`
// with source OUTPUT over every free text the model wrote, with
//
//   grounding_source  the redacted tool results of the turn (`Runtime/TURN#`) and the firm's
//                     checklist, newest last, clipped from the oldest side to the Linkable's limit
//   query             for a `REPLY`, the importer's question (clipped); for every other kind, a fixed
//                     description of the message built by the code
//   guard_content     the text, which must fit the content limit whole (a text that does not fit is
//                     never half-checked)
//
// The verdict applies the thresholds of `GuardrailG2` itself: grounding always, relevance only for a
// `REPLY` (a proactive notice answers no question), and any topic or word block of G1's denied topics.
// A failed call fails closed: nothing leaves without G2. The single Bedrock runtime client of the
// pipeline (timeouts, retries with backoff, error mapping) lives here.
import { ApplyGuardrailCommand, type ApplyGuardrailCommandOutput, BedrockRuntimeClient, type GuardrailAssessment, type GuardrailContentBlock } from "@aws-sdk/client-bedrock-runtime";
import { z } from "zod";
import type { Guardrail, MessageKind } from "@legajo/shared";
import { awsClientConfig, type ClientTimeouts } from "../lib/clients";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";

/** `Resource.GuardrailG2` (infra/guardrail.ts): the published version, its thresholds and its input limits. */
export const G2Config = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  groundingThreshold: z.number().min(0).max(1),
  relevanceThreshold: z.number().min(0).max(1),
  queryMaxChars: z.number().int().positive(),
  groundingSourceMaxChars: z.number().int().positive(),
  contentMaxChars: z.number().int().positive(),
});
export type G2Config = z.infer<typeof G2Config>;

export function linkedG2Config(): G2Config {
  return readLinked("GuardrailG2", G2Config);
}

export interface G2Input {
  readonly kind: MessageKind;
  readonly text: string;
  readonly groundingSource: string;
  readonly query: string;
}

export type G2Failure = "GROUNDING" | "RELEVANCE" | "BLOCKED" | "TOO_LONG";

export interface G2Verdict extends Guardrail {
  readonly relevanceScore?: number;
  readonly failure?: G2Failure;
}

export interface OutputGuardrail {
  check(input: G2Input): Promise<G2Verdict>;
}

export class GuardrailUnavailableError extends Error {
  override readonly name = "GuardrailUnavailableError";
}

// ---- What G2 reads ---------------------------------------------------------------------------------

/** One JSON line per tool result and per checklist item source, clipped from the oldest side. */
export function groundingSourceOf(sources: readonly { readonly tool: string; readonly output: unknown }[], maxChars: number): string {
  const text = sources.map((source) => JSON.stringify({ tool: source.tool, output: source.output })).join("\n");
  return text.length <= maxChars ? text : text.slice(text.length - maxChars);
}

/** What a proactive message is about, in the words relevance is scored against. */
const KIND_QUERIES: Readonly<Record<MessageKind, string>> = {
  DOCS_REQUEST: "Which documents of this import operation are missing and who has to send them?",
  REMINDER: "Which documents are still missing and by when?",
  CORRECTION_REQUEST: "What has to be corrected in the document and by when?",
  NO_ACTION_NEEDED: "Does the importer have to do anything about this observation?",
  CONTACT_REQUEST: "Which supplier contact should we write to?",
  CONTACT_CONFIRMATION: "May we write to this supplier contact?",
  UPLOAD_LINK: "How can the importer upload the missing documents?",
  ETA_CHANGE: "What changed in the estimated arrival and the deadline?",
  ESCALATION_NOTICE: "Who of the firm will follow up?",
  ESCALATION: "Why is the operation handed to the firm?",
  APPROVAL_NOTICE: "Was the dossier approved?",
  DISPATCH_STATUS: "What is the customs status of the dispatch?",
  REPLY: "What did the importer ask?",
  BROKER_MESSAGE: "What does the firm say?",
  OPT_OUT_CONFIRMATION: "Will the importer receive more notices?",
  OPERATION_CHOICE: "Which operation is the message about?",
};

/** The importer's question for a `REPLY` (clipped), the kind's description otherwise. */
export function queryOf(kind: MessageKind, question: string | undefined, maxChars: number): string {
  const query = kind === "REPLY" && question !== undefined && question.trim() !== "" ? question.trim() : KIND_QUERIES[kind];
  return query.slice(0, maxChars);
}

export function contentBlocks(input: G2Input, config: Pick<G2Config, "queryMaxChars" | "groundingSourceMaxChars">): GuardrailContentBlock[] {
  return [
    { text: { text: input.groundingSource.slice(-config.groundingSourceMaxChars) || "{}", qualifiers: ["grounding_source"] } },
    { text: { text: input.query.slice(0, config.queryMaxChars) || "-", qualifiers: ["query"] } },
    { text: { text: input.text, qualifiers: ["guard_content"] } },
  ];
}

// ---- The verdict -----------------------------------------------------------------------------------

function scoreOf(assessments: readonly GuardrailAssessment[], type: "GROUNDING" | "RELEVANCE"): number | undefined {
  let score: number | undefined;
  for (const assessment of assessments) {
    for (const filter of assessment.contextualGroundingPolicy?.filters ?? []) {
      if (filter.type === type && filter.score !== undefined) score = score === undefined ? filter.score : Math.min(score, filter.score);
    }
  }
  return score;
}

/** A block of any policy other than contextual grounding: the denied topics and words of G1 on output. */
function blockedByPolicy(assessments: readonly GuardrailAssessment[]): boolean {
  return assessments.some(
    (assessment) =>
      (assessment.topicPolicy?.topics ?? []).some((topic) => topic.action === "BLOCKED") ||
      (assessment.wordPolicy?.customWords ?? []).some((word) => word.action === "BLOCKED") ||
      (assessment.wordPolicy?.managedWordLists ?? []).some((word) => word.action === "BLOCKED") ||
      (assessment.contentPolicy?.filters ?? []).some((filter) => filter.action === "BLOCKED") ||
      (assessment.sensitiveInformationPolicy?.piiEntities ?? []).some((entity) => entity.action === "BLOCKED") ||
      (assessment.sensitiveInformationPolicy?.regexes ?? []).some((regex) => regex.action === "BLOCKED"),
  );
}

export function verdictOf(response: Pick<ApplyGuardrailCommandOutput, "action" | "assessments">, kind: MessageKind, config: Pick<G2Config, "groundingThreshold" | "relevanceThreshold">): G2Verdict {
  const assessments = response.assessments ?? [];
  const groundingScore = scoreOf(assessments, "GROUNDING");
  const relevanceScore = scoreOf(assessments, "RELEVANCE");
  const scores = { ...(groundingScore === undefined ? {} : { groundingScore }), ...(relevanceScore === undefined ? {} : { relevanceScore }) };
  if (response.action === "GUARDRAIL_INTERVENED" && blockedByPolicy(assessments)) return { action: "BLOCKED", ...scores, failure: "BLOCKED" };
  // A grounding check that returned no score did not check anything: fail closed.
  if (groundingScore === undefined || groundingScore < config.groundingThreshold) return { action: "BLOCKED", ...scores, failure: "GROUNDING" };
  if (kind === "REPLY" && (relevanceScore === undefined || relevanceScore < config.relevanceThreshold)) return { action: "BLOCKED", ...scores, failure: "RELEVANCE" };
  return { action: "NONE", ...scores };
}

// ---- Bedrock ---------------------------------------------------------------------------------------

// ApplyGuardrail answers in a few hundred milliseconds; two SDK attempts of 4 s and one retry of our
// own stay well inside the timeout of a messaging tool.
export const G2_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 4_000, connectionTimeoutMs: 1_000, maxAttempts: 2 };

const RETRYABLE = new Set(["ThrottlingException", "ServiceUnavailableException", "InternalServerException", "ServiceQuotaExceededException"]);

function isRetryableSdk(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  return RETRYABLE.has(name) || (typeof error === "object" && error !== null && "$retryable" in error);
}

let client: BedrockRuntimeClient | undefined;

/** The Bedrock runtime client of `ApplyGuardrail`, one per container. */
export function bedrockRuntimeClient(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient(awsClientConfig(G2_TIMEOUTS));
  return client;
}

export interface BedrockG2Deps {
  readonly client: Pick<BedrockRuntimeClient, "send">;
  readonly config: () => G2Config;
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createBedrockG2(deps: BedrockG2Deps = { client: bedrockRuntimeClient(), config: linkedG2Config }): OutputGuardrail {
  return {
    async check(input) {
      const config = deps.config();
      if (input.text.length > config.contentMaxChars) return { action: "BLOCKED", failure: "TOO_LONG" };
      const command = new ApplyGuardrailCommand({ guardrailIdentifier: config.id, guardrailVersion: config.version, source: "OUTPUT", content: contentBlocks(input, config) });
      try {
        const response = await withRetry(() => deps.client.send(command), { attempts: 2, shouldRetry: isRetryableSdk, ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }) });
        return verdictOf(response, input.kind, config);
      } catch (error) {
        throw new GuardrailUnavailableError("ApplyGuardrail failed", { cause: error });
      }
    },
  };
}
