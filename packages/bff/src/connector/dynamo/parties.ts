// The `Parties` adapter: importer side, supplier side and the address claims that keep every phone
// and email unique, composed into one port.
import type { PartiesPort } from "../ports";
import { addressClaimsRepo } from "./address-claims";
import { importersRepo } from "./importers";
import type { RepoContext } from "./repo";
import { suppliersRepo } from "./suppliers";

export function partiesRepo(ctx: RepoContext): PartiesPort {
  return { ...importersRepo(ctx), ...suppliersRepo(ctx), ...addressClaimsRepo(ctx) };
}
