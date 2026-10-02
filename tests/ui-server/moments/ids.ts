// The moments of the guest's world, in the order of the guided tour (docs/landing-spec.md §7.2.1).
export const MOMENT_IDS = ["start", "after-request", "after-delegate", "after-supplier-email", "after-reading", "after-correction", "after-eta-move", "after-escalation", "after-approval", "after-dispatch"] as const;
export type MomentId = (typeof MOMENT_IDS)[number];
