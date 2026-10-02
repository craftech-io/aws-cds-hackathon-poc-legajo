// Facts of the story of operation 4471 that the tour draws besides the conversations
// (conversations.ts): the reader's result on the documents of the supplier's emails (never read by us,
// ADR-0003) and the milestones the ETA change moves. Times are simulated.

/** Milestones the ETA change of step 6 moves: the ETA − 3 days reminder, the ETA − 48 h escalation and the arrival. */
export const ETA_MILESTONES = [
  { id: "followupFinal", before: "19/10 10:00", after: "17/10 10:00" },
  { id: "escalation", before: "20/10 08:00", after: "18/10 08:00" },
  { id: "arrival", before: "22/10 08:00", after: "20/10 08:00" },
] as const;
export type EtaMilestoneId = (typeof ETA_MILESTONES)[number]["id"];

/** The reader's result on the documents of the supplier's emails, after the email that carried them. */
export const READINGS = [
  { after: "reply", docType: "PACKING_LIST", version: 1, status: "WITH_OBSERVATION" },
  { after: "reply", docType: "CERTIFICATE_OF_ORIGIN", version: 1, status: "VALID" },
  { after: "corrected", docType: "PACKING_LIST", version: 2, status: "VALID" },
] as const;
