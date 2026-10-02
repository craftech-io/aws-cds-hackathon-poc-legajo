// The four tiles of "Impacto" (docs/landing-spec.md §1.7): three goals of the buyer that the console
// measures in every world with its N, and one guarantee in code. Never a result: every tile carries its
// label, and the only numbers the section may show are these counts.
import type { GoalKind } from "../../components/StatTile";

export const IMPACT_TILES = [
  { id: "complete72h", kind: "goal", count: 72 },
  { id: "sameDay", kind: "goal", count: undefined },
  { id: "oneStory", kind: "goal", count: 100 },
  { id: "humanApproval", kind: "guarantee", count: 100 },
] as const satisfies ReadonlyArray<{ readonly id: string; readonly kind: GoalKind; readonly count: number | undefined }>;

export type ImpactTileId = (typeof IMPACT_TILES)[number]["id"];

/** Numbers allowed in `#impact` (landing.test.ts). */
export const IMPACT_NUMBERS: readonly number[] = [72, 100];
