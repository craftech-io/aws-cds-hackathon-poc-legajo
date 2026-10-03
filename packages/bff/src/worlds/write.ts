// Writes a planned world at an epoch (docs/seed-spec.md §14 and §16, docs/architecture.md §5):
//
//   1 the template's items, completed for the world and the epoch (instantiate.ts)
//   2 a broker row that already exists keeps its Cognito `sub`, its world lease and its switch: a
//     reload or a reset never unbinds an account (`cognitoSub` conservado)
//   3 the address claims `Parties/ADDR#<hash>` of every thread address, importer phone and contact
//     mailbox, each a conditional put: a claim held by another owner aborts with CONFLICT
//     (`ADDRESS_TAKEN`) after releasing the claims this write took, and writes nothing else
//   4 every domain item through the seed store (each validated with its entity's schema and key shape)
//   5 the `Platform` rows `POP#<firmId>#<number>`, written directly with the capability `WORLDS`
//
// The clock is the caller's: the factory creates it last, a reset only moves it.
import { ConnectorError, ToolError } from "@legajo/shared";
import { toPlatformOperationItem } from "@legajo/platform-mock/schema";
import { addressClaimKey, brokerKey } from "../connector/keys";
import type { Item } from "../connector/table-client";
import type { SeedTable } from "../connector/ports-runtime";
import { type InstanceOptions, type WorldItem, addressHashOf, instantiateItems, keyedItem, renameDeep } from "./instantiate";
import type { WorldsDeps } from "./deps";
import type { WorldPlan } from "./plan";
import type { TemplateItem } from "./template";

const DOMAIN_ORDER: readonly SeedTable[] = ["Firms", "Parties", "Operations", "Conversations", "AuditLog", "LegajoMetrics"];

export interface WrittenOperation {
  readonly operationId: string;
  readonly operationNumber: string;
  readonly threadAddress: string;
}

export interface WrittenWorld {
  readonly operations: readonly WrittenOperation[];
  readonly counts: Readonly<Partial<Record<SeedTable | "Platform", number>>>;
}

/** A broker row that exists keeps its binding (`cognitoSub`, `leaseId`, `active`). */
async function keepBindings(items: readonly WorldItem[], deps: Pick<WorldsDeps, "client">): Promise<WorldItem[]> {
  const out: WorldItem[] = [];
  for (const item of items) {
    if (item.entity !== "Broker") {
      out.push(item);
      continue;
    }
    const stored = await deps.client.get("Firms", brokerKey(String(item.firmId), String(item.brokerId)));
    if (stored === undefined || typeof stored.cognitoSub !== "string" || stored.cognitoSub === "") {
      out.push(item);
      continue;
    }
    const { cognitoSubKey: _key, ...rest } = item;
    out.push(keyedItem({ ...rest, cognitoSub: stored.cognitoSub, active: stored.active ?? true, ...(typeof stored.leaseId === "string" ? { leaseId: stored.leaseId } : {}) }));
  }
  return out;
}

interface ClaimSpec {
  readonly addressHash: string;
  readonly kind: "PHONE" | "EMAIL" | "THREAD";
  readonly ownerType: "IMPORTER" | "SUPPLIER_CONTACT" | "OPERATION";
  readonly ownerId: string;
}

function claimsOf(items: Readonly<Record<SeedTable, WorldItem[]>>, deps: Pick<WorldsDeps, "keys">): ClaimSpec[] {
  const claims: ClaimSpec[] = [];
  for (const item of items.Operations) if (item.entity === "Operation") claims.push({ addressHash: addressHashOf(deps.keys, String(item.threadAddress)), kind: "THREAD", ownerType: "OPERATION", ownerId: String(item.operationId) });
  for (const item of items.Parties) {
    if (item.entity === "Importer") claims.push({ addressHash: String(item.phoneHash), kind: "PHONE", ownerType: "IMPORTER", ownerId: String(item.importerId) });
    if (item.entity === "SupplierContact") claims.push({ addressHash: String(item.emailHash), kind: "EMAIL", ownerType: "SUPPLIER_CONTACT", ownerId: String(item.contactId) });
  }
  return claims;
}

/** Takes every claim or none: a claim of another owner releases what this write took and throws CONFLICT. */
async function claimAddresses(claims: readonly ClaimSpec[], plan: WorldPlan, stamp: InstanceOptions["stamp"], deps: Pick<WorldsDeps, "client" | "seed" | "now">): Promise<void> {
  const taken: ClaimSpec[] = [];
  const at = deps.now().toISOString();
  for (const claim of claims) {
    const item = keyedItem({ entity: "AddressClaim", ...claim, firmId: plan.firmId, clockId: plan.clockId, createdAt: at, updatedAt: at, version: 1, synthetic: true, ...stampOf(stamp) });
    const problems = deps.seed.validateItems("Parties", [item]);
    if (problems.length > 0) throw new ConnectorError("VALIDATION", `invalid address claim: ${problems[0] ?? ""}`, "Parties");
    try {
      await deps.client.put("Parties", item, { ifNotExists: true });
      taken.push(claim);
    } catch (error) {
      if (!(error instanceof ConnectorError && error.code === "CONFLICT")) throw error;
      const held = await deps.client.get("Parties", addressClaimKey(claim.addressHash));
      if (held?.ownerId === claim.ownerId && held.firmId === plan.firmId) continue;
      for (const mine of taken) await deps.client.delete("Parties", addressClaimKey(mine.addressHash), { equals: { ownerId: mine.ownerId } });
      throw new ToolError("CONFLICT", `a ${claim.kind.toLowerCase()} of ${claim.ownerId} is already claimed by another world`, "ADDRESS_TAKEN");
    }
  }
}

function stampOf(stamp: InstanceOptions["stamp"]): Record<string, unknown> {
  return { ...(stamp.world === undefined ? {} : { world: stamp.world }), ...(stamp.runId === undefined ? {} : { runId: stamp.runId }), ...(stamp.expiresAt === undefined ? {} : { expiresAt: stamp.expiresAt }) };
}

const PLATFORM_META_FIELDS = new Set(["PK", "SK", "entity", "createdAt", "updatedAt", "version", "clockId", "world", "runId", "expiresAt", "synthetic"]);

function platformRows(rows: readonly TemplateItem[], plan: WorldPlan, stamp: InstanceOptions["stamp"], now: Date): Item[] {
  return rows.map((row) => {
    const data = Object.fromEntries(Object.entries(renameDeep(row, plan.renames) as Record<string, unknown>).filter(([field]) => !PLATFORM_META_FIELDS.has(field)));
    return toPlatformOperationItem({ ...data, firmId: plan.firmId } as Parameters<typeof toPlatformOperationItem>[0], { now, synthetic: true, clockId: plan.clockId, ...stampOf(stamp) }) as unknown as Item;
  });
}

/** Writes the world of `plan` at `worldEpoch` (see the header); the clock is not touched. */
export async function writeWorld(plan: WorldPlan, worldEpoch: number, deps: Pick<WorldsDeps, "client" | "seed" | "keys" | "now">): Promise<WrittenWorld> {
  const stamp = { ...plan.stamp, worldEpoch };
  const options: InstanceOptions = { renames: plan.renames, stamp, keys: deps.keys, createdAt: deps.now().toISOString(), ...(plan.providerTag === undefined ? {} : { providerTag: plan.providerTag }) };
  const threads = new Map<string, string>();
  const items = {} as Record<SeedTable, WorldItem[]>;
  // Operations first: the seeded emails of the other tables cite their thread addresses.
  for (const table of ["Operations", ...DOMAIN_ORDER.filter((name) => name !== "Operations")] as SeedTable[]) {
    items[table] = await instantiateItems((plan.items as Record<string, readonly TemplateItem[]>)[table] ?? [], options, threads);
  }
  items.Firms = await keepBindings(items.Firms, deps);
  for (const table of DOMAIN_ORDER) {
    const problems = deps.seed.validateItems(table, items[table]);
    if (problems.length > 0) throw new ConnectorError("VALIDATION", `${problems.length} invalid item(s) of ${plan.clockId} in ${table}: ${problems.slice(0, 3).join(" | ")}`, table);
  }
  await claimAddresses(claimsOf(items, deps), plan, stamp, deps);
  const counts: Partial<Record<SeedTable | "Platform", number>> = {};
  for (const table of DOMAIN_ORDER) {
    if (items[table].length === 0) continue;
    await deps.seed.loadItems(table, items[table]);
    counts[table] = items[table].length;
  }
  const platform = platformRows(plan.items.Platform, plan, stamp, deps.now());
  if (platform.length > 0) {
    await deps.client.batchPut("Platform", platform);
    counts.Platform = platform.length;
  }
  const operations = items.Operations.filter((item) => item.entity === "Operation").map((item) => ({ operationId: String(item.operationId), operationNumber: String(item.operationNumber), threadAddress: String(item.threadAddress) }));
  return { operations, counts };
}
