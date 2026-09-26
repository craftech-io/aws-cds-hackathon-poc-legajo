// Actions the `QaDriver` answers from stored state (docs/tool-catalog.md "Acciones del QaDriver"):
// `snapshot`, `op.settle`, `mail.outcome`, `supplier.setBehaviour`, `link.expire`, `nonce.expire`,
// `policyAudit.run` and `metrics.get`. The two expirations write through the raw table client with a
// condition on the item's own `clockId` (`qa-*` only), so a demo or judge link can never be touched
// whatever key the lookup built.
import { ToolError, type WaButtonAction } from "@legajo/shared";
import type { TableClient } from "../connector/index";
import { nonceKey, uploadLinkKey } from "../connector/keys";
import type { Message } from "../domain/conversations";
import { PUBLIC_TOKEN_PATTERN } from "../lib/crypto";
import { runPolicyAudit } from "../policy-audit/audit";
import { QA_REASON } from "./contract";
import type { QaParsedInput } from "./contract-inputs";
import type { ActionContext } from "./ports";
import { settleOperation } from "./settle";
import { buildSnapshot } from "./snapshot";

/** Only items of a scenario world: the condition of every write the expirations make. */
const QA_ITEM = { oneOf: { attribute: "clockId", prefixes: ["qa-"] } } as const;

const MAIL_POLL_MS = 2_000;

/** Newest first: the outbound messages to the importer. */
async function outboundToImporter(ctx: ActionContext, operationId: string): Promise<Message[]> {
  const messages = await ctx.data.conversations.listMessages(operationId, { direction: "OUT" });
  return messages.filter((message) => message.counterpart === "IMPORTER").reverse();
}

/** Token of the last upload link sent to the importer (URL button, template parameter or body). */
export function uploadTokenOf(message: Pick<Message, "buttons" | "template" | "body">): string | undefined {
  const texts = [...message.buttons.map((button) => button.url ?? ""), ...(message.template?.params ?? []), message.body];
  for (const text of texts) {
    for (const match of text.matchAll(/\/u\/([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g)) {
      const token = match[1] ?? "";
      if (PUBLIC_TOKEN_PATTERN.test(token)) return token;
    }
    if (PUBLIC_TOKEN_PATTERN.test(text)) return text;
  }
  return undefined;
}

export async function lastUploadToken(ctx: ActionContext, operationId: string): Promise<string> {
  for (const message of await outboundToImporter(ctx, operationId)) {
    const token = uploadTokenOf(message);
    if (token !== undefined) return token;
  }
  throw new ToolError("NOT_FOUND", `no message of ${operationId} carries an upload link yet`);
}

/** Nonce of the button `action` on the last message that carried one. */
export async function lastNonce(ctx: ActionContext, operationId: string, action: WaButtonAction): Promise<string> {
  for (const message of await outboundToImporter(ctx, operationId)) {
    const nonce = message.buttons.find((button) => button.action === action && button.nonce !== undefined)?.nonce;
    if (nonce !== undefined) return nonce;
  }
  throw new ToolError("NOT_FOUND", `no message of ${operationId} carries a ${action} button yet`);
}

export const snapshotAction = (input: QaParsedInput<"snapshot">, ctx: ActionContext) => buildSnapshot(ctx.data, input.operationId, ctx.now());

export const settleAction = (input: QaParsedInput<"op.settle">, ctx: ActionContext) => settleOperation({ data: ctx.data, now: ctx.now, sleep: ctx.sleep }, input);

/** Waits for `PROBE#MAIL#<mailId>`; a probe of another world reads as absent. */
export async function mailOutcomeAction(input: QaParsedInput<"mail.outcome">, ctx: ActionContext) {
  const deadline = ctx.now().getTime() + input.timeoutSec * 1_000;
  for (;;) {
    const probe = await ctx.data.runtime.getMailProbe(input.mailId);
    if (probe !== undefined && probe.clockId === input.clockId) return { mailId: probe.mailId, outcome: probe.outcome, reason: probe.reason ?? null, operationId: probe.operationId ?? null, atReal: probe.atReal };
    const left = deadline - ctx.now().getTime();
    if (left <= 0) throw new ToolError("NOT_FOUND", `no outcome for mail ${input.mailId} after ${input.timeoutSec} s`, QA_REASON.NO_OUTCOME);
    await ctx.sleep(Math.min(MAIL_POLL_MS, left));
  }
}

export async function setBehaviourAction(input: QaParsedInput<"supplier.setBehaviour">, ctx: ActionContext) {
  const operation = await ctx.data.operations.updateOperation(input.operationId, { simBehaviour: input.behaviour, ...(input.delayHours === undefined ? {} : { simBehaviourParams: { delayHours: input.delayHours } }) });
  return { operationId: operation.operationId, simBehaviour: operation.simBehaviour };
}

export function expireActions(table: TableClient) {
  return {
    /** The link of the last message stops opening the page: `expiresAtReal` one second ago. */
    async linkExpire(input: QaParsedInput<"link.expire">, ctx: ActionContext) {
      const token = await lastUploadToken(ctx, input.operationId);
      const now = ctx.now();
      await table.update("Runtime", uploadLinkKey(token), { set: { expiresAtReal: new Date(now.getTime() - 1_000).toISOString() } }, now.toISOString(), { condition: { ifExists: true, ...QA_ITEM } });
      return { expired: true };
    },
    /** The nonce of that button on the last message expires (its `expiresAt` goes one second back). */
    async nonceExpire(input: QaParsedInput<"nonce.expire">, ctx: ActionContext) {
      const nonce = await lastNonce(ctx, input.operationId, input.action);
      const now = ctx.now();
      await table.update("Runtime", nonceKey(nonce), { set: { expiresAt: Math.floor(now.getTime() / 1_000) - 1 } }, now.toISOString(), { condition: { ifExists: true, ...QA_ITEM } });
      return { expired: true, action: input.action };
    },
  };
}

/** `PolicyAudit` over every message of the world (the same module the daily schedule runs). */
export async function policyAuditAction(input: QaParsedInput<"policyAudit.run">, ctx: ActionContext) {
  const report = await runPolicyAudit({ data: ctx.data, now: ctx.now, log: ctx.log, correlationId: ctx.log.correlationId }, { firmId: ctx.scope.firmId, clockId: input.clockId });
  return {
    clockId: input.clockId,
    operations: report.operations,
    messagesChecked: report.messagesChecked,
    failed: report.failed,
    violations: report.violations.map((violation) => ({ operationId: violation.operationId, messageId: violation.messageId, check: violation.check, ruleIds: violation.ruleIds })),
  };
}

/** Raw usage of the world's KPI rows (the runner's turn and cost budget). */
export async function usageOfWorld(ctx: ActionContext, clockId: string) {
  const rows = await ctx.data.metrics.listKpis(ctx.scope.firmId, { source: "WORLD", clockId });
  const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
  return {
    dossiers: rows.length,
    turns: sum((row) => row.turns),
    inputTokens: sum((row) => row.inputTokens),
    outputTokens: sum((row) => row.outputTokens),
    cacheReadTokens: sum((row) => row.cacheReadTokens),
    cacheWriteTokens: sum((row) => row.cacheWriteTokens),
    whatsappSent: sum((row) => row.whatsappSent),
    emailSent: sum((row) => row.emailSent),
    violations: sum((row) => row.violations),
  };
}
