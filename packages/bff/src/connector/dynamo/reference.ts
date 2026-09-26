// `Reference`: read-only catalogs the seed writes (`REF#<type>#<scope>` + the key of the type,
// docs/seed-spec.md §12). The only write is the template status the WhatsApp templates script records.
import type { ReferenceType } from "@legajo/shared";
import { DispatchGlossary, EvalTruth, Holiday, NameCheck, ObservationCodeLabel, RateCard, Template } from "../../domain/reference";
import type { TableName } from "../../lib/resource";
import { REFERENCE_SCOPES, glossarySortKey, referenceKey, referencePartition } from "../keys";
import type { ReferencePort } from "../ports-runtime";
import { optionalEntity, parseEntities, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Reference";

export function referenceRepo(ctx: RepoContext): ReferencePort {
  const { client } = ctx;
  const all = (type: ReferenceType, scope: string) => client.query(TABLE, { hashValue: referencePartition(type, scope) });

  return {
    async listHolidays(country) {
      return parseEntities(Holiday, "Holiday", await all("HOLIDAY", country), TABLE);
    },

    async getTemplate(name) {
      return optionalEntity(Template, "Template", await client.get(TABLE, referenceKey("TEMPLATE", REFERENCE_SCOPES.TEMPLATE, name)), TABLE);
    },

    async listTemplates() {
      return parseEntities(Template, "Template", await all("TEMPLATE", REFERENCE_SCOPES.TEMPLATE), TABLE);
    },

    async updateTemplate(name, patch) {
      const key = referenceKey("TEMPLATE", REFERENCE_SCOPES.TEMPLATE, name);
      const template = requireEntity(Template, "Template", await client.get(TABLE, key), TABLE, `template ${name}`);
      return updateRow(ctx, TABLE, Template, "Template", key, { set: { ...patch } }, { condition: { ifVersion: template.version } });
    },

    async listRateCard() {
      return parseEntities(RateCard, "RateCard", await all("RATECARD", REFERENCE_SCOPES.RATECARD), TABLE);
    },

    async getDispatchGlossary(status, channel) {
      const key = referenceKey("DISPATCH_GLOSSARY", REFERENCE_SCOPES.DISPATCH_GLOSSARY, glossarySortKey(status, channel));
      return optionalEntity(DispatchGlossary, "DispatchGlossary", await client.get(TABLE, key), TABLE);
    },

    async listObservationLabels() {
      return parseEntities(ObservationCodeLabel, "ObservationCode", await all("OBS_CODE", REFERENCE_SCOPES.OBS_CODE), TABLE);
    },

    async listEvalTruth(operationId) {
      return parseEntities(EvalTruth, "EvalTruth", await all("EVAL", operationId), TABLE);
    },

    async listNameChecks() {
      return parseEntities(NameCheck, "NameCheck", await all("NAMECHECK", REFERENCE_SCOPES.NAMECHECK), TABLE);
    },
  };
}
