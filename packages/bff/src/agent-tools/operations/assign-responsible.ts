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

/** Who the matrix names for the observation, with `SENDER` resolved to the party of the version it came in. */
async function matrixPartyOf(ctx: ToolContext<Input>, observation: Observation): Promise<Party> {
  const { connector, scope } = ctx;
  const matrix = await connector.firms.getResponsibilityMatrix(scope.firmId);
  const responsible: MatrixResponsible = matrix === undefined ? "BROKER" : matrixDefault(matrix, observation.docType, observation.code).responsible;
  if (responsible !== "SENDER") return responsible;
  const version = await connector.documents.findVersion(observation.lastDocVersionId);
  return version?.source.party ?? "BROKER";
}

export const assignResponsible: ToolImplementation<Input> = async (ctx) => {
  const { connector, scope, input } = ctx;
  const observation = await connector.documents.findObservation(scope.operationId, input.observationId);
  if (observation === undefined) return fail("NOT_FOUND", "no such observation in this operation");
  if (!OPEN_OBSERVATION_STATUSES.includes(observation.status)) return fail("CONFLICT", `the observation is ${observation.status}; it needs no responsible`);
  const fromMatrix = await matrixPartyOf(ctx, observation);
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
