// The scenes of the landing: the main story of operation 4471 (docs/design-brief.md §4) in the order
// of the demo video (§14), one step each. What a scene says lives in copy (`story.scenes`, es and en);
// here is only what it shows. Times are simulated: the demo clock is paused and moves with a button.
import type { ContactPolicyRuleId, RuleId } from "@legajo/shared";
import type { ConversationId } from "./conversations";
import type { MediaId } from "./manifest";

export const SCENE_IDS = ["request", "delegate", "supplier", "noAction", "question", "eta", "approval", "policy"] as const;
export type SceneId = (typeof SCENE_IDS)[number];

/** A deferral the contact policy decided in that scene (the pending the console shows with its reason). */
export interface SceneDeferral {
  readonly rule: Extract<ContactPolicyRuleId, "CP-HOURS-SUPPLIER" | "CP-HOURS-AR">;
  readonly note: "supplierHours" | "importerHours";
}

export type SceneVisual =
  | { readonly kind: "phone"; readonly conversation: ConversationId; readonly deferral?: SceneDeferral; readonly media?: MediaId }
  | { readonly kind: "supplier" }
  | { readonly kind: "eta" }
  | { readonly kind: "decisions" };

export interface Scene {
  readonly id: SceneId;
  /** Simulated time in Argentina when the scene happens. */
  readonly when?: string;
  readonly visual: SceneVisual;
}

export const SCENES: readonly Scene[] = [
  { id: "request", when: "15/10 10:00", visual: { kind: "phone", conversation: "request" } },
  { id: "delegate", when: "15/10 10:00", visual: { kind: "phone", conversation: "delegate", deferral: { rule: "CP-HOURS-SUPPLIER", note: "supplierHours" } } },
  { id: "supplier", when: "15/10 22:00", visual: { kind: "supplier" } },
  { id: "noAction", when: "16/10 09:00", visual: { kind: "phone", conversation: "noAction", deferral: { rule: "CP-HOURS-AR", note: "importerHours" } } },
  { id: "question", when: "16/10 09:20", visual: { kind: "phone", conversation: "question" } },
  { id: "eta", when: "16/10 10:00", visual: { kind: "eta" } },
  { id: "approval", when: "16/10 11:00", visual: { kind: "phone", conversation: "approval", media: "console-dossier" } },
  { id: "policy", visual: { kind: "decisions" } },
];

/** Milestones the ETA change of scene 6 moves: the ETA − 3 days reminder, the ETA − 48 h escalation and the arrival. */
export const ETA_MILESTONES = [
  { id: "followupFinal", before: "19/10 10:00", after: "17/10 10:00" },
  { id: "escalation", before: "20/10 08:00", after: "18/10 08:00" },
  { id: "arrival", before: "22/10 08:00", after: "20/10 08:00" },
] as const;
export type EtaMilestoneId = (typeof ETA_MILESTONES)[number]["id"];

/** Decisions of scene 8, each with the rule that took it; the words live in copy (`story.decisions`). */
export const DECISIONS = [
  { rule: "CP-HOURS-SUPPLIER", outcome: "deferred" },
  { rule: "CP-HOURS-AR", outcome: "deferred" },
  { rule: "CP-ONE-PER-DAY", outcome: "denied" },
  { rule: "CP-OPTIN", outcome: "denied" },
  { rule: "CP-NO-FOREIGN-LINKS", outcome: "denied" },
  { rule: "CED-NO-APPROVE", outcome: "denied" },
] as const satisfies ReadonlyArray<{ readonly rule: RuleId; readonly outcome: "deferred" | "denied" }>;
export type DecisionRule = (typeof DECISIONS)[number]["rule"];

/** The reader's result on the documents of scene 3 (never read by us, ADR-0003), after the email that carried them. */
export const READINGS = [
  { after: "reply", docType: "PACKING_LIST", version: 1, status: "WITH_OBSERVATION" },
  { after: "reply", docType: "CERTIFICATE_OF_ORIGIN", version: 1, status: "VALID" },
  { after: "corrected", docType: "PACKING_LIST", version: 2, status: "VALID" },
] as const;
