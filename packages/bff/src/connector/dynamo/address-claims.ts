// `Parties/ADDR#<hash>` / `CLAIM`: one row per phone, email or thread address in use. Created with
// `attribute_not_exists` in the same transaction as its owner, so a collision is a CONFLICT that
// writes nothing and two importers never share a `phoneHash` nor two contacts an `emailHash`
// (docs/architecture.md §5, "Reglas de escritura"). Released only by the owner that holds it.
import { ConnectorError } from "@legajo/shared";
import { AddressClaim } from "../../domain/parties";
import type { NewEntity } from "../../domain/common";
import type { TableName } from "../../lib/resource";
import { addressClaimKey } from "../keys";
import type { PartiesPort } from "../ports";
import type { Item, TransactOp } from "../table-client";
import { buildRow, createRow, optionalEntity, type RepoContext } from "./repo";

const TABLE: TableName = "Parties";

export function claimRow(ctx: RepoContext, claim: NewEntity<typeof AddressClaim>): Item {
  return buildRow(ctx, TABLE, AddressClaim, "AddressClaim", addressClaimKey(claim.addressHash), claim).item;
}

/** Deletes a claim only while `ownerId` holds it (the transaction fails otherwise). */
export function releaseClaimOp(addressHash: string, ownerId: string): TransactOp {
  return { op: "delete", table: TABLE, key: addressClaimKey(addressHash), condition: { equals: { ownerId } } };
}

type ClaimMethods = Pick<PartiesPort, "getAddressClaim" | "claimAddress" | "releaseAddress">;

export function addressClaimsRepo(ctx: RepoContext): ClaimMethods {
  const { client } = ctx;
  return {
    async getAddressClaim(addressHash) {
      return optionalEntity(AddressClaim, "AddressClaim", await client.get(TABLE, addressClaimKey(addressHash)), TABLE);
    },

    async claimAddress(claim) {
      return createRow(ctx, TABLE, AddressClaim, "AddressClaim", addressClaimKey(claim.addressHash), claim);
    },

    async releaseAddress(addressHash, ownerId) {
      const current = optionalEntity(AddressClaim, "AddressClaim", await client.get(TABLE, addressClaimKey(addressHash)), TABLE);
      if (current === undefined) return;
      if (current.ownerId !== ownerId) throw new ConnectorError("CONFLICT", `address claim held by another owner`, TABLE);
      await client.delete(TABLE, addressClaimKey(addressHash), { equals: { ownerId }, ifVersion: current.version });
    },
  };
}
