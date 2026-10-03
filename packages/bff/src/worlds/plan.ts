// Which world a request asks for, and the template-shaped items that make it (docs/seed-spec.md §3 and
// §14): a demo world is its template as it is (plus the operator's phone overrides), a guest world is
// the `guest` template renamed for its slot, and a QA run or a metrics batch is a set of clones of
// model operations (clones.ts). The plan names the world's clock, firm, stamp and start; the factory
// writes it (write.ts).
import { type WorldTemplateName, qaClockId, simClockId } from "@legajo/shared";
import { QA_WORLD_TTL_SECONDS } from "../domain/common";
import { type CloneEntry, type ClonedOperation, type LeaseTaker, planClones } from "./clones";
import { NO_RENAMES, type Renames, type WorldStamp, renameString } from "./instantiate";
import type { TemplateItem, TemplateTable, WorldTemplate } from "./template";
import { guestIdentity, guestRenames } from "./world-ids";

export type DemoTemplate = Extract<WorldTemplateName, "demo-firm-delta" | "demo-firm-norte" | "qa-min">;

export type WorldRequest =
  /** `GLOBAL#firm-delta`, `GLOBAL#firm-norte` or `GLOBAL#firm-qa`; `importerPhones` from `SeedOverrides`. */
  | { readonly kind: "DEMO"; readonly template: DemoTemplate; readonly importerPhones?: Readonly<Record<string, string>> }
  /** `GUEST#firm-guest-<nn>` or `GUEST#firm-guest-test`; a public slot passes its hard expiry (TTL + 24 h). */
  | { readonly kind: "GUEST"; readonly firmId: string; readonly hardExpiresAtReal?: string }
  | { readonly kind: "QA"; readonly runId: string; readonly scenario: string; readonly startAtSim: string; readonly entries: readonly CloneEntry[]; readonly rateLimitPerHour?: number }
  | { readonly kind: "BATCH"; readonly batchId: string; readonly startAtSim: string; readonly entries: readonly CloneEntry[] };

export interface WorldPlan {
  readonly clockId: string;
  readonly firmId: string;
  readonly template: WorldTemplateName;
  readonly startAtSim: string;
  readonly stamp: Omit<WorldStamp, "worldEpoch">;
  readonly renames: Renames;
  readonly providerTag?: string;
  readonly items: Readonly<Record<TemplateTable, readonly TemplateItem[]>>;
  /** Operations as the world will hold them (ids renamed; thread addresses come with the epoch). */
  readonly operations: readonly ClonedOperation[];
  /** Mailbox of the world's firm (`estudio-<slug>@sim…`, `estudio-qa-<runId>-<scenario>@sim…`). */
  readonly firmMailbox: string;
  readonly settings?: { readonly rateLimitPerHour: number };
  readonly leases: ReadonlyArray<{ readonly kind: "PHONE" | "OPNUM"; readonly value: string }>;
}

/** Demo templates and the firm each writes. */
export const DEMO_FIRMS: Readonly<Record<DemoTemplate, string>> = { "demo-firm-delta": "firm-delta", "demo-firm-norte": "firm-norte", "qa-min": "firm-qa" };

/** The template a world's clock is rebuilt from ("Reiniciar demo", the nightly reset). */
export function templateOfClock(clockId: string): WorldTemplateName | undefined {
  if (clockId.startsWith("GUEST#")) return "guest";
  const demo = (Object.entries(DEMO_FIRMS) as Array<[DemoTemplate, string]>).find(([, firmId]) => clockId === `GLOBAL#${firmId}`);
  return demo?.[0];
}

/** The clock a request names, before anything is read. */
export function clockOfRequest(request: WorldRequest): string {
  switch (request.kind) {
    case "DEMO":
      return `GLOBAL#${DEMO_FIRMS[request.template]}`;
    case "GUEST":
      return guestIdentity(request.firmId).clockId;
    case "QA":
      return qaClockId(request.runId, request.scenario);
    case "BATCH":
      return simClockId(request.batchId);
  }
}

function firmMailboxOf(items: readonly TemplateItem[], renames: Renames, fallback: string): string {
  const firm = items.find((item) => item.entity === "Firm");
  return firm === undefined ? fallback : renameString(String(firm.mailboxAddress), renames);
}

function templateOperations(template: WorldTemplate, renames: Renames): ClonedOperation[] {
  return template.operations.map((operation) => ({
    key: operation.operationId,
    operationId: renameString(operation.operationId, renames),
    operationNumber: operation.operationNumber,
    importerId: renameString(operation.importerId, renames),
    supplierId: renameString(operation.supplierId, renames),
    contacts: [],
  }));
}

const DAY_SECONDS = 24 * 60 * 60;

/** The plan of a demo or guest world from its template. */
export function planFromTemplate(template: WorldTemplate, request: Extract<WorldRequest, { kind: "DEMO" | "GUEST" }>): WorldPlan {
  if (request.kind === "DEMO") {
    const phones = new Map<string, string>();
    for (const item of template.items.Parties) {
      const override = item.entity === "Importer" ? request.importerPhones?.[String(item.importerId)] : undefined;
      if (override !== undefined) phones.set(String(item.phoneE164), override);
    }
    const renames: Renames = phones.size === 0 ? NO_RENAMES : { ...NO_RENAMES, exact: phones };
    const firmId = DEMO_FIRMS[request.template];
    return {
      clockId: `GLOBAL#${firmId}`,
      firmId,
      template: request.template,
      startAtSim: template.startAtSim,
      stamp: { clockId: `GLOBAL#${firmId}`, ...(request.template === "qa-min" ? { world: "qa" as const } : {}) },
      renames,
      items: template.items,
      operations: templateOperations(template, renames),
      firmMailbox: firmMailboxOf(template.items.Firms, renames, `estudio-${firmId.replace(/^firm-/, "")}@sim.legajo.demo.craftech.io`),
      leases: [],
    };
  }
  const identity = guestIdentity(request.firmId);
  const renames = guestRenames(template, identity);
  const expiresAt = request.hardExpiresAtReal === undefined ? undefined : Math.floor(Date.parse(request.hardExpiresAtReal) / 1000) + DAY_SECONDS;
  return {
    clockId: identity.clockId,
    firmId: identity.firmId,
    template: "guest",
    startAtSim: template.startAtSim,
    stamp: { clockId: identity.clockId, world: identity.world, ...(expiresAt === undefined ? {} : { expiresAt }) },
    renames,
    providerTag: identity.tag,
    items: { ...template.items, Firms: template.items.Firms.map((item) => withGuestKind(item, identity.guestKind)) },
    operations: templateOperations(template, renames),
    firmMailbox: firmMailboxOf(template.items.Firms, renames, `estudio-g${identity.block}@sim.legajo.demo.craftech.io`),
    leases: [],
  };
}

/** The guest firm row says whether it is a reserved account's or a public slot's (docs/architecture.md §5). */
function withGuestKind(item: TemplateItem, guestKind: "PUBLIC" | "RESERVED"): TemplateItem {
  return item.entity === "Firm" ? { ...item, kind: "GUEST", guestKind } : item;
}

/** The plan of a QA run or a metrics batch: the leases are taken here. */
export async function planFromModels(models: WorldTemplate, request: Extract<WorldRequest, { kind: "QA" | "BATCH" }>, take: LeaseTaker, realNow: Date): Promise<WorldPlan> {
  const clockId = clockOfRequest(request);
  const isQa = request.kind === "QA";
  const firmId = isQa ? "firm-qa" : "firm-sim";
  const clones = await planClones(models, { clockId, firmId, brokerId: isQa ? "brk-qa-runner" : "brk-qa-analyst", entries: request.entries }, take);
  return {
    clockId,
    firmId,
    template: "models",
    startAtSim: request.startAtSim,
    stamp: { clockId, ...(isQa ? { world: "qa" as const, runId: request.runId, expiresAt: Math.floor(realNow.getTime() / 1000) + QA_WORLD_TTL_SECONDS } : {}) },
    renames: NO_RENAMES,
    items: clones.items,
    operations: clones.operations,
    firmMailbox: `estudio-${clockId}@sim.legajo.demo.craftech.io`,
    ...(isQa ? { settings: { rateLimitPerHour: request.rateLimitPerHour ?? 20 } } : {}),
    leases: clones.leases,
  };
}
