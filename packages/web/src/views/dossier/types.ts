// Shapes the files views read, taken from the BFF's own router type (lib/trpc-router.ts): the list
// of operations, the dossier of one, its timeline with the pending timers, and the decisions of the
// audit log. Nothing here is written by hand, so a change of the BFF shows up as a type error.
import type { RouterOutputs } from "../../lib/trpc-router";

export type OperationsList = RouterOutputs["operations"]["list"];
export type OperationRow = OperationsList["operations"][number];

export type DossierData = RouterOutputs["operations"]["get"];
export type DocumentData = DossierData["documents"][number];
export type VersionData = DossierData["versions"][number];
export type ObservationData = DossierData["observations"][number];
export type EscalationData = DossierData["escalations"][number];

export type TimelineData = RouterOutputs["operations"]["timeline"];
export type TimelineEntryData = TimelineData["entries"][number];
export type MessageData = Extract<TimelineEntryData, { readonly type: "MESSAGE" }>["message"];
export type PendingTimerData = TimelineData["pending"][number];

export type DecisionData = RouterOutputs["audit"]["list"]["decisions"][number];

export type EscalationsList = RouterOutputs["escalations"]["list"];
