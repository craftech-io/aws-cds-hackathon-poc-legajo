// scripts/landing/captures.json: the console captures of the landing (docs/landing-spec.md §7.3), each
// with its view, the moment of the guest's world it shows (tests/ui-server/moments/) and what to do
// before the frame. An entry marked `pending` names why its view cannot be captured yet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { CONSOLE_CAPTURE_IDS, type ConsoleCaptureId } from "../../packages/web/src/views/landing/manifest";
import { MOMENT_IDS } from "../../tests/ui-server/moments/ids";

export const Capture = z
  .object({
    view: z.string().regex(/^\/app\/[a-z0-9/-]*$/),
    moment: z.enum(MOMENT_IDS),
    select: z.object({ label: z.string().min(1), value: z.string().min(1) }).strict().optional(),
    scrollTo: z.string().regex(/^#[a-z-]+$/).optional(),
    tour: z.literal("open").optional(),
    /** Why the view cannot be captured yet: skipped by capture-console.ts, listed by landing:check. */
    pending: z.string().min(1).optional(),
  })
  .strict();
export type Capture = z.infer<typeof Capture>;

const CapturesFile = z.object({ _readme: z.string(), captures: z.record(z.enum(CONSOLE_CAPTURE_IDS), Capture) }).strict();

export function readCaptures(path: string = join(import.meta.dirname, "captures.json")): Readonly<Record<ConsoleCaptureId, Capture>> {
  return CapturesFile.parse(JSON.parse(readFileSync(path, "utf8"))).captures;
}
