// `assign_responsible` (docs/tool-catalog.md, FL-022, FL-040, FL-042): the agent decides who corrects
// an observation of the turn's operation and the tool compares the choice with the firm's
// responsibility matrix (`Firms/RESP_MATRIX#v<nnn>`). A choice the matrix does not give, and every
// BROKER choice, is flagged for the firm's review; nothing is refused for disagreeing with the matrix.
// The matrix row `SENDER` (`LOW_CONFIDENCE`) means whoever sent the version the observation was read
// in. The rationale is the model's text: it is masked before it is stored and never goes to a log.
import { type MatrixResponsible, type Party, fail, ok } from "@legajo/shared";
import { type Observation, OPEN_OBSERVATION_STATUSES } from "../../domain/documents";
import { matrixDefault } from "../../domain/firms";
import { maskText } from "../../lib/mask";
import type { ToolContext, ToolImplementation } from "../common/context";
import type { ToolInput } from "../common/define";
import type { OPERATIONS_TOOLS } from "./schema";

type Input = ToolInput<(typeof OPERATIONS_TOOLS)["assign_responsible"]>;

/** A matrix responsible with `SENDER` resolved to the party of the version the observation came in. */
async function partyOf(ctx: ToolContext<Input>, observation: Observation, responsible: MatrixResponsible): Promise<Party> {
  if (responsible !== "SENDER") return responsible;
  const version = await ctx.connector.documents.findVersion(observation.lastDocVersionId);
  return version?.source.party ?? "BROKER";
}

/**
 * Who the matrix names for this step of the observation: its first responsible, or the one that
 * follows (`then`, `BUYER_DATA_MISMATCH`: importer, then supplier) once the first one has it and the
 * agent hands it on (FL-039).
 */
async function matrixPartyOf(ctx: ToolContext<Input>, observation: Observation, chosen: Party): Promise<Party> {
  const { connector, scope } = ctx;
  const matrix = await connector.firms.getResponsibilityMatrix(scope.firmId);
  if (matrix === undefined) return "BROKER";
  const row = matrixDefault(matrix, observation.docType, observation.code);
  const first = await partyOf(ctx, observation, row.responsible);
  if (row.then === undefined || observation.responsibleParty !== first) return first;
  const then = await partyOf(ctx, observation, row.then);
  return chosen === then ? then : first;
}

export const assignResponsible: ToolImplementation<Input> = async (ctx) => {
  const { connector, scope, input } = ctx;
  const observation = await connector.documents.findObservation(scope.operationId, input.observationId);
  if (observation === undefined) return fail("NOT_FOUND", "no such observation in this operation");
  if (!OPEN_OBSERVATION_STATUSES.includes(observation.status)) return fail("CONFLICT", `the observation is ${observation.status}; it needs no responsible`);
  const fromMatrix = await matrixPartyOf(ctx, observation, input.responsibleParty);
  const matchesMatrix = input.responsibleParty === fromMatrix;
  const flaggedForReview = !matchesMatrix || input.responsibleParty === "BROKER";
  await connector.documents.updateObservation(
    scope.operationId,
    observation.observationId,
    { responsibleParty: input.responsibleParty, matrixDefault: fromMatrix, matchesMatrix, flaggedForReview, rationale: maskText(input.rationale).slice(0, 300) },
    observation.version,
  );
  const document = await connector.documents.getDocument(scope.operationId, observation.docType);
  if (document.responsibleParty !== input.responsibleParty) await connector.documents.updateDocument(scope.operationId, observation.docType, { responsibleParty: input.responsibleParty }, document.version);
  await ctx.audit({
    decision: "ACTION",
    action: "ASSIGN_RESPONSIBLE",
    ruleIds: ["RESP-MATRIX"],
    refs: { observationId: observation.observationId },
    detail: { code: observation.code, docType: observation.docType, responsibleParty: input.responsibleParty, matrixDefault: fromMatrix, matchesMatrix, flaggedForReview },
  });
  return ok({ matchesMatrix, matrixDefault: fromMatrix, flaggedForReview });
};
