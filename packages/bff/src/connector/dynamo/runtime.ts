// `Runtime`, per-turn and per-request state: sessions, turns and their results (the grounding
// source of G2), button nonces, upload links, idempotency marks, rate and turn-cap counters, named
// counters and probes. Every row carries its TTL (docs/architecture.md §5); counters are atomic
// `ADD`s on upserted rows, so concurrent Lambdas never lose a count.
import type { z } from "zod";
import { ConnectorError } from "@legajo/shared";
import type { EntityName } from "../../domain/common";
import { AccountPreferences, Counter, Idempotency, MAX_PRESIGNS_PER_LINK, MailProbe, Nonce, Probe, RUNTIME_TTL_SECONDS, RateCounter, Session, Turn, TurnCap, TurnResult, UploadLink } from "../../domain/runtime";
import type { TableName } from "../../lib/resource";
import {
  RESULT_PREFIX,
  accountPreferencesKey,
  counterKey,
  idempotencyKey,
  mailProbeKey,
  nonceKey,
  probeKey,
  rateKey,
  sessionKey,
  turnCapKey,
  turnKey,
  turnPartition,
  turnResultKey,
  uploadLinkKey,
} from "../keys";
import type { RuntimePort } from "../ports-runtime";
import type { Key } from "../table-client";
import { buildRow, createRow, creationDefaults, nowIso, optionalEntity, parseEntities, parseEntity, requireEntity, updateRow, type RepoContext } from "./repo";

const TABLE: TableName = "Runtime";
const TTL = RUNTIME_TTL_SECONDS;

export function runtimeRepo(ctx: RepoContext): RuntimePort {
  const { client } = ctx;

  const isConflict = (error: unknown): boolean => error instanceof ConnectorError && error.code === "CONFLICT";

  /** Unconditional write of a row that may be rewritten (probes). */
  async function overwrite<T>(schema: z.ZodType<T>, entity: EntityName, key: Key, fields: Readonly<Record<string, unknown>>, ttlSeconds: number): Promise<T> {
    const { item, value } = buildRow(ctx, TABLE, schema, entity, key, fields, { ttlSeconds });
    await client.put(TABLE, item);
    return value;
  }

  return {
    async putSession(session) {
      return createRow(ctx, TABLE, Session, "Session", sessionKey(session.sessionId), session, { ttlSeconds: TTL.session });
    },

    async getSession(sessionId) {
      return optionalEntity(Session, "Session", await client.get(TABLE, sessionKey(sessionId)), TABLE);
    },

    async openTurn(turn) {
      return createRow(ctx, TABLE, Turn, "Turn", turnKey(turn.turnId), turn, { ttlSeconds: TTL.turn });
    },

    async getTurn(turnId) {
      return optionalEntity(Turn, "Turn", await client.get(TABLE, turnKey(turnId)), TABLE);
    },

    // Closing twice keeps the first close: a token of a closed turn stays refused.
    async closeTurn(turnId, closedAtReal) {
      try {
        return await updateRow(ctx, TABLE, Turn, "Turn", turnKey(turnId), { set: { closedAtReal } }, { condition: { absent: ["closedAtReal"] } });
      } catch (error) {
        if (!isConflict(error)) throw error;
        return requireEntity(Turn, "Turn", await client.get(TABLE, turnKey(turnId)), TABLE, `turn ${turnId}`);
      }
    },

    async appendTurnResult(input) {
      const turn = await updateRow(ctx, TABLE, Turn, "Turn", turnKey(input.turnId), { add: { resultCount: 1 } }, { condition: { absent: ["closedAtReal"] } });
      return createRow(ctx, TABLE, TurnResult, "TurnResult", turnResultKey(input.turnId, input.tool, turn.resultCount), { turnId: input.turnId, tool: input.tool, seq: turn.resultCount, output: input.output, atReal: input.atReal }, { ttlSeconds: TTL.turn });
    },

    async listTurnResults(turnId) {
      const rows = await client.query(TABLE, { hashValue: turnPartition(turnId), range: { prefix: RESULT_PREFIX } });
      return parseEntities(TurnResult, "TurnResult", rows, TABLE).sort((a, b) => a.seq - b.seq);
    },

    async putNonce(nonce) {
      return createRow(ctx, TABLE, Nonce, "Nonce", nonceKey(nonce.nonce), nonce, { ttlSeconds: TTL.nonce });
    },

    async getNonce(nonce) {
      return optionalEntity(Nonce, "Nonce", await client.get(TABLE, nonceKey(nonce)), TABLE);
    },

    async useNonce(nonce, usedAtReal) {
      return updateRow(ctx, TABLE, Nonce, "Nonce", nonceKey(nonce), { set: { usedAtReal } }, { condition: { absent: ["usedAtReal"] } });
    },

    async putUploadLink(link) {
      return createRow(ctx, TABLE, UploadLink, "UploadLink", uploadLinkKey(link.token), link, { ttlSeconds: TTL.link });
    },

    async getUploadLink(token) {
      return optionalEntity(UploadLink, "UploadLink", await client.get(TABLE, uploadLinkKey(token)), TABLE);
    },

    async recordPresign(token, atReal) {
      return updateRow(ctx, TABLE, UploadLink, "UploadLink", uploadLinkKey(token), { set: { lastActivityAtReal: atReal }, add: { presignCount: 1 } }, {
        condition: { atMost: { attribute: "presignCount", value: MAX_PRESIGNS_PER_LINK - 1 } },
      });
    },

    async completeUploadLink(token, atReal) {
      return updateRow(ctx, TABLE, UploadLink, "UploadLink", uploadLinkKey(token), { set: { completedAtReal: atReal, lastActivityAtReal: atReal } });
    },

    async claimIdempotency(input) {
      try {
        await createRow(ctx, TABLE, Idempotency, "Idempotency", idempotencyKey(input.source, input.id), { source: input.source, id: input.id, firstSeenAtReal: input.atReal, result: input.result }, { ttlSeconds: TTL.idempotency });
        return true;
      } catch (error) {
        if (isConflict(error)) return false;
        throw error;
      }
    },

    async getIdempotency(source, id) {
      return optionalEntity(Idempotency, "Idempotency", await client.get(TABLE, idempotencyKey(source, id)), TABLE);
    },

    async incrementRate(input) {
      const identity = { clockId: input.clockId, addressHash: input.addressHash, simHour: input.simHour };
      const row = await client.update(TABLE, rateKey(input.clockId, input.addressHash, input.simHour), { add: { count: 1 }, setIfAbsent: creationDefaults(ctx, "RateCounter", identity, TTL.rate) }, nowIso(ctx), { upsert: true });
      return parseEntity(RateCounter, "RateCounter", row, TABLE).count;
    },

    async incrementTurnCap(input) {
      const identity = { firmId: input.firmId, window: input.window };
      const row = await client.update(TABLE, turnCapKey(input.firmId, input.window), { add: { count: 1 }, setIfAbsent: creationDefaults(ctx, "TurnCap", identity, TTL.turnCap) }, nowIso(ctx), { upsert: true });
      return parseEntity(TurnCap, "TurnCap", row, TABLE).count;
    },

    async incrementCounter(name, by = 1) {
      const row = await client.update(TABLE, counterKey(name), { add: { value: by }, setIfAbsent: creationDefaults(ctx, "Counter", { name }) }, nowIso(ctx), { upsert: true });
      return parseEntity(Counter, "Counter", row, TABLE).value;
    },

    async putProbe(probe) {
      return overwrite(Probe, "Probe", probeKey(probe.probeId), probe, TTL.probe);
    },

    async getProbe(probeId) {
      return optionalEntity(Probe, "Probe", await client.get(TABLE, probeKey(probeId)), TABLE);
    },

    async putMailProbe(probe) {
      return overwrite(MailProbe, "MailProbe", mailProbeKey(probe.mailId), probe, TTL.probe);
    },

    async getMailProbe(mailId) {
      return optionalEntity(MailProbe, "MailProbe", await client.get(TABLE, mailProbeKey(mailId)), TABLE);
    },

    async getAccountPreferences(sub) {
      return optionalEntity(AccountPreferences, "AccountPreferences", await client.get(TABLE, accountPreferencesKey(sub)), TABLE);
    },

    // An upsert of one attribute: the row has no TTL and carries no world stamp (nothing resets it).
    async setAccountLanguage(sub, language) {
      const row = await client.update(TABLE, accountPreferencesKey(sub), { set: { language }, setIfAbsent: creationDefaults(ctx, "AccountPreferences", { sub }) }, nowIso(ctx), { upsert: true });
      return parseEntity(AccountPreferences, "AccountPreferences", row, TABLE);
    },
  };
}
