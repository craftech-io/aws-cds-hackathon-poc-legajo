// `Firms`: the firm, its settings, brokers (GSI1 by Cognito `sub`), and the latest version of the
// checklist and of the responsibility matrix (descending query on the `v<nnn>` sort keys).
import { DocType } from "@legajo/shared";
import { Broker, Checklist, Firm, FirmSettings, ResponsibilityMatrix } from "../../domain/firms";
import type { TableName } from "../../lib/resource";
import { BROKER_PREFIX, MATRIX_PREFIX, brokerKey, checklistPrefix, cognitoSubKey, firmKey, firmPartition, firmSettingsKey } from "../keys";
import type { FirmsPort } from "../ports";
import { optionalEntity, parseEntities, pinnedVersion, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Firms";

export function firmsRepo(ctx: RepoContext): FirmsPort {
  const { client } = ctx;

  async function latestChecklist(firmId: string, docType: DocType): Promise<Checklist | undefined> {
    const rows = await client.query(TABLE, { hashValue: firmPartition(firmId), range: { prefix: checklistPrefix(docType) }, descending: true, limit: 1 });
    return rows[0] === undefined ? undefined : parseEntities(Checklist, "Checklist", rows, TABLE)[0];
  }

  return {
    async getFirm(firmId) {
      return requireEntity(Firm, "Firm", await client.get(TABLE, firmKey(firmId)), TABLE, `firm ${firmId}`);
    },

    async findFirm(firmId) {
      return optionalEntity(Firm, "Firm", await client.get(TABLE, firmKey(firmId)), TABLE);
    },

    async getSettings(firmId) {
      return requireEntity(FirmSettings, "FirmSettings", await client.get(TABLE, firmSettingsKey(firmId)), TABLE, `settings of ${firmId}`);
    },

    async getBroker(firmId, brokerId) {
      return requireEntity(Broker, "Broker", await client.get(TABLE, brokerKey(firmId, brokerId)), TABLE, `broker ${brokerId}`);
    },

    async listBrokers(firmId) {
      const rows = await client.query(TABLE, { hashValue: firmPartition(firmId), range: { prefix: BROKER_PREFIX } });
      return parseEntities(Broker, "Broker", rows, TABLE);
    },

    // The sub is global to the user pool; the firm filter keeps a row of another firm from ever
    // becoming this principal's broker.
    async findBrokerBySub(firmId, sub) {
      if (sub === "") return undefined;
      const rows = await client.query(TABLE, { index: "GSI1", hashValue: cognitoSubKey(sub), filter: { equals: { firmId, entity: "Broker" } }, limit: 2 });
      const brokers = parseEntities(Broker, "Broker", rows, TABLE);
      return brokers.length === 1 ? brokers[0] : undefined;
    },

    async setBrokerCognitoSub(firmId, brokerId, sub) {
      const key = brokerKey(firmId, brokerId);
      const version = await pinnedVersion(ctx, TABLE, key, undefined, `broker ${brokerId}`);
      return updateRow(ctx, TABLE, Broker, "Broker", key, { set: { cognitoSub: sub, cognitoSubKey: sub === "" ? null : cognitoSubKey(sub) } }, { condition: { ifVersion: version } });
    },

    async getChecklist(firmId, docType) {
      return latestChecklist(firmId, docType);
    },

    async listChecklists(firmId) {
      const latest = await Promise.all(DocType.options.map((docType) => latestChecklist(firmId, docType)));
      return latest.filter((checklist): checklist is Checklist => checklist !== undefined);
    },

    async getResponsibilityMatrix(firmId) {
      const rows = await client.query(TABLE, { hashValue: firmPartition(firmId), range: { prefix: MATRIX_PREFIX }, descending: true, limit: 1 });
      return optionalEntity(ResponsibilityMatrix, "ResponsibilityMatrix", rows[0], TABLE);
    },
  };
}
