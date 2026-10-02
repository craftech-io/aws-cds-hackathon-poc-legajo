// Implementations of the `operations` tools behind `createToolHandler` (docs/tool-catalog.md, target
// `operations`): five reads of the turn's operation and `assign_responsible`, its only write.
import type { Implementations } from "../common/context";
import { assignResponsible } from "./assign-responsible";
import { getCounterpartProfile } from "./counterpart";
import { getChecklist, getDispatchStatus, getDossier, getOperation } from "./reads";
import type { OPERATIONS_TOOLS } from "./schema";

export const operationsImplementations: Implementations<typeof OPERATIONS_TOOLS> = {
  get_operation: getOperation,
  get_dossier: getDossier,
  assign_responsible: assignResponsible,
  get_counterpart_profile: getCounterpartProfile,
  get_checklist: getChecklist,
  get_dispatch_status: getDispatchStatus,
};
