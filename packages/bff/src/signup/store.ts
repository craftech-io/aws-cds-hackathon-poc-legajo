// `Leads/SIGNUP#<signupId>` (ADR-0015 §2): a sign-up between `signup.start` and `finalizeSignup`.
// Every write is conditional on what it read (`version` or `dispatchSeq`), so a repeated or stale
// dispatch event, two tabs resending at once or a retried confirmation cannot move it twice. An item
// past its `expiresAt` reads as absent: DynamoDB deletes expired items lazily.
import { ConnectorError } from "@legajo/shared";
import type { SignupBranch } from "@legajo/shared/signup";
import { SIGNUP_PENDING_TTL_SECONDS } from "@legajo/shared/guest-limits";
import type { TableClient } from "../connector/index";
import { LEADS_TABLE, PendingSignup, signupKey } from "../leads/lead";

export type NewPendingSignup = Omit<PendingSignup, "version" | "expiresAt" | "dispatchSeq" | "dispatchedSeq" | "resends" | "attempts" | "branch" | "accountUsername" | "dispatchedAt" | "verifiedAt" | "lastResendAt">;

export interface SignupStore {
  create(signup: NewPendingSignup, now: Date): Promise<PendingSignup>;
  get(signupId: string, now: Date): Promise<PendingSignup | undefined>;
  /** A resend: `dispatchSeq + 1`, `resends + 1`, `lastResendAt`; CONFLICT when another write won. */
  recordResend(signup: PendingSignup, now: Date): Promise<PendingSignup>;
  /**
   * First step of a dispatch: removes the sealed password and returns it, only while `dispatchSeq` is
   * the event's. `undefined` for a stale or repeated event (nothing is done).
   */
  claimDispatch(signupId: string, dispatchSeq: number, now: Date): Promise<{ readonly signup: PendingSignup; readonly sealed?: string } | undefined>;
  /** The branch the dispatch decided, only while `dispatchSeq` is still the sign-up's; false when a newer one took over. */
  setBranch(signupId: string, dispatchSeq: number, branch: SignupBranch, now: Date, accountUsername?: string): Promise<boolean>;
  recordWrongCode(signup: PendingSignup, now: Date): Promise<PendingSignup>;
  markVerified(signupId: string, now: Date): Promise<void>;
  delete(signupId: string): Promise<void>;
  /** Every pending sign-up still in its TTL (the hourly sweep). */
  listPending(now: Date): Promise<PendingSignup[]>;
}

function live(row: Record<string, unknown> | undefined, now: Date): PendingSignup | undefined {
  if (row === undefined) return undefined;
  const parsed = PendingSignup.safeParse(row);
  if (!parsed.success) throw new ConnectorError("VALIDATION", "a pending sign-up does not match its schema", "Leads");
  return parsed.data.expiresAt * 1000 > now.getTime() ? parsed.data : undefined;
}

function isConflict(error: unknown): boolean {
  return error instanceof ConnectorError && error.code === "CONFLICT";
}

export function createSignupStore(client: TableClient): SignupStore {
  async function get(signupId: string, now: Date): Promise<PendingSignup | undefined> {
    return live(await client.get(LEADS_TABLE, signupKey(signupId)), now);
  }

  return {
    get,

    async create(signup, now) {
      const item = {
        ...signupKey(signup.signupId),
        entity: "PendingSignup",
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        version: 1,
        ...signup,
        dispatchSeq: 1,
        resends: 0,
        attempts: 0,
        expiresAt: Math.floor(now.getTime() / 1000) + SIGNUP_PENDING_TTL_SECONDS,
      };
      const parsed = PendingSignup.parse(item);
      await client.put(LEADS_TABLE, item, { ifNotExists: true });
      return parsed;
    },

    async recordResend(signup, now) {
      const stored = await client.update(
        LEADS_TABLE,
        signupKey(signup.signupId),
        { set: { lastResendAt: now.toISOString() }, add: { dispatchSeq: 1, resends: 1 } },
        now.toISOString(),
        { condition: { ifVersion: signup.version } },
      );
      return PendingSignup.parse(stored);
    },

    async claimDispatch(signupId, dispatchSeq, now) {
      const signup = await get(signupId, now);
      if (signup === undefined || signup.dispatchSeq !== dispatchSeq || signup.dispatchedSeq === dispatchSeq) return undefined;
      try {
        await client.update(LEADS_TABLE, signupKey(signupId), { set: { passwordSealed: null, dispatchedAt: now.toISOString(), dispatchedSeq: dispatchSeq } }, now.toISOString(), { condition: { ifVersion: signup.version } });
      } catch (error) {
        if (isConflict(error)) return undefined;
        throw error;
      }
      return signup.passwordSealed === undefined ? { signup } : { signup, sealed: signup.passwordSealed };
    },

    async setBranch(signupId, dispatchSeq, branch, now, accountUsername) {
      try {
        await client.update(LEADS_TABLE, signupKey(signupId), { set: { branch, ...(accountUsername === undefined ? {} : { accountUsername }) } }, now.toISOString(), { condition: { equals: { dispatchSeq } } });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    async recordWrongCode(signup, now) {
      const stored = await client.update(LEADS_TABLE, signupKey(signup.signupId), { add: { attempts: 1 } }, now.toISOString());
      return PendingSignup.parse(stored);
    },

    async markVerified(signupId, now) {
      await client.update(LEADS_TABLE, signupKey(signupId), { set: { verifiedAt: now.toISOString() } }, now.toISOString());
    },

    async delete(signupId) {
      await client.delete(LEADS_TABLE, signupKey(signupId));
    },

    async listPending(now) {
      const rows = await client.scan(LEADS_TABLE, { filter: { equals: { entity: "PendingSignup" } } });
      return rows.flatMap((row) => {
        const signup = live(row, now);
        return signup === undefined ? [] : [signup];
      });
    },
  };
}
