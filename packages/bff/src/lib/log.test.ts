import { describe, expect, it } from "vitest";
import { ChannelError, ConnectorError } from "@legajo/shared";
import { MASK, correlationIdFrom, createLogger, redactFields, redactText } from "./log";

function capture(level: "debug" | "info" = "debug") {
  const lines: string[] = [];
  const logger = createLogger({ correlationId: "corr-0001-test", level, sink: (line) => lines.push(line), now: () => new Date("2026-09-08T13:00:00Z"), bindings: { service: "inbound-whatsapp" } });
  return { logger, lines, last: (): Record<string, unknown> => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
}

describe("logger", () => {
  it("writes one JSON line with level, time, correlation id and bindings", () => {
    const { logger, lines, last } = capture();
    logger.info("turn finished", { turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
    expect(lines).toHaveLength(1);
    expect(last()).toEqual({ level: "info", time: "2026-09-08T13:00:00.000Z", correlationId: "corr-0001-test", message: "turn finished", service: "inbound-whatsapp", turnId: "01J7TURN", durationMs: 1840, toolCalls: 3 });
  });

  it("carries the correlation id into child loggers and respects the level", () => {
    const { logger, lines, last } = capture("info");
    const child = logger.child({ tool: "get_dossier" });
    child.debug("not written");
    child.warn("slow call");
    expect(lines).toHaveLength(1);
    expect(last()).toMatchObject({ level: "warn", correlationId: "corr-0001-test", service: "inbound-whatsapp", tool: "get_dossier" });
    expect(child.correlationId).toBe(logger.correlationId);
  });

  it("[FL-050] masks E.164 numbers and emails wherever they appear", () => {
    const { logger, last, lines } = capture();
    logger.info("inbound from +54 9 11 5550-0101 and ops.lead@supplier.sim", { phoneE164: "+5491155500101", email: "ops.lead@supplier.sim", address: "+5491155500102", to: "op-4471-k2@legajo.demo.craftech.io", note: "llamar al +54 9 11 5550 0102" });
    expect(last()).toMatchObject({ message: `inbound from ${MASK.phone} and ${MASK.email}`, phoneE164: MASK.phone, email: MASK.email, address: MASK.phone, to: MASK.email, note: `llamar al ${MASK.phone}` });
    expect(lines[0]).not.toMatch(/5550|ops\.lead|craftech\.io/);
  });

  it("[FL-050] masks CUIT/CUIL, DNI, CBU/CVU, cards and IBAN with the markers of the normalizer", () => {
    const { logger, last, lines } = capture();
    logger.info("importer wrote sensitive data", {
      note: "Te paso el CUIT 30-71234567-9, mi DNI 12.345.678 y el CBU 0170099220000067797370",
      card: "4111 1111 1111 1111",
      detail: "tarjeta 4111-1111-1111-1111, IBAN DE89 3704 0044 0532 0130 00",
      cvu: "0000003100010000000001",
      dni: "23456789",
    });
    expect(last()).toMatchObject({
      note: `Te paso el CUIT ${MASK.cuit}, mi DNI ${MASK.dni} y el CBU ${MASK.cbu}`,
      card: MASK.card,
      detail: `tarjeta ${MASK.card}, IBAN ${MASK.iban}`,
      cvu: MASK.cbu,
      dni: MASK.dni,
    });
    expect(lines[0]).not.toMatch(/71234567|345\.678|0170099|4111|3704|0000003100/);
  });

  it("[FL-050] masks documents, names and amounts; invoice values are never logged", () => {
    const { logger, last, lines } = capture();
    logger.info("statement built", {
      displayName: "Nora Quintana", document: "27-14555666-3", cuitInText: "CUIT 27-14555666-3 DNI 1020304050", invoiceValue: { amount: 66_820_000, currency: "USD", amountText: "$ 668.200,00" },
      totalPending: 66_820_000, text: "El valor declarado es $ 668.200,00", summary: "valor $ 668.200,00 informado", operationId: "op-4471",
    });
    expect(last()).toMatchObject({ displayName: MASK.name, document: MASK.document, cuitInText: `CUIT ${MASK.cuit} DNI ${MASK.number}`, invoiceValue: MASK.amount, totalPending: MASK.amount, text: MASK.omitted, summary: `valor ${MASK.amount} informado`, operationId: "op-4471" });
    expect(lines[0]).not.toMatch(/668|Quintana|14555666/);
  });

  it("[FL-050] never logs session tokens, secrets or seed overrides", () => {
    const { logger, lines } = capture();
    logger.info("tool call", { sessionToken: "01J7SESSION.01J7TURN.1792000000.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmUtc2lnbmF0", subkey: "k", seedOverrides: { demoRecipients: { emails: ["team@corp.sim"] } } });
    expect(lines[0]).not.toMatch(/SESSION|c2lnbmF0|team@corp/);
  });

  it("drops raw provider events and tool results, keeps hashes, ids and instants", () => {
    const { logger, last } = capture();
    const addressHash = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    logger.debug("sns event", { event: { Records: [{ Sns: { Message: "{...}" } }] }, toolResult: { ok: true, total: 1 }, addressHash, providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ", receivedAt: "2026-09-08T10:00:00-03:00", expiresAt: 1788872400000, sizeBytes: 4_500_000 });
    expect(last()).toMatchObject({ event: MASK.omitted, toolResult: MASK.omitted, addressHash, providerMessageId: "01J7ABCDEFGHJKMNPQRSTVWXYZ", receivedAt: "2026-09-08T10:00:00-03:00", expiresAt: 1788872400000, sizeBytes: 4_500_000 });
  });

  it("serialises typed errors with their code and a redacted message", () => {
    const { logger, last } = capture();
    const cause = new ConnectorError("THROTTLED", "table throttled", "Parties");
    logger.error("send failed", { error: new ChannelError("SEND_FAILED", "WHATSAPP", "cannot reach +5491155500101", { cause }) });
    expect(last().error).toMatchObject({ name: "ChannelError", code: "SEND_FAILED", channel: "WHATSAPP", retryable: true, message: `cannot reach ${MASK.phone}`, cause: { name: "ConnectorError", code: "THROTTLED", table: "Parties" } });
  });

  it("survives circular structures, huge strings and deep nesting", () => {
    const { logger, last } = capture();
    const circular: Record<string, unknown> = { id: "a" };
    circular.self = circular;
    logger.info("odd input", { circular, long: "x".repeat(5_000), deep: { a: { b: { c: { d: { e: { f: { g: "too deep" } } } } } } } });
    const record = last();
    expect(JSON.stringify(record)).toContain("truncated 3000");
    expect(JSON.stringify(record.deep)).toContain(MASK.omitted);
    expect(record.message).toBe("odd input");
  });

  it("does not let a field overwrite the envelope", () => {
    const { logger, last } = capture();
    logger.info("real message", { level: "debug", correlationId: "spoofed" });
    expect(last()).toMatchObject({ level: "info", correlationId: "corr-0001-test", field_level: "debug", field_correlationId: "spoofed" });
  });
});

describe("redaction helpers", () => {
  it("leaves dates and ids alone", () => {
    expect(redactText("2026-09-08T10:00:00-03:00")).toBe("2026-09-08T10:00:00-03:00");
    expect(redactText("doc-op-4471-PACKING_LIST-v2 on 2026-10-14")).toBe("doc-op-4471-PACKING_LIST-v2 on 2026-10-14");
    expect(redactText("factura INV-2026-118, página 3")).toBe("factura INV-2026-118, página 3");
    expect(redactText("dv-4471-PL-2 weighs 12.480 kg, eta 22/10 08:00")).toBe("dv-4471-PL-2 weighs 12.480 kg, eta 22/10 08:00");
  });

  it("masks long free-standing digit runs and formatted money", () => {
    expect(redactText("DNI 1020304050 pagó $486.000")).toBe(`DNI ${MASK.number} pagó ${MASK.amount}`);
    expect(redactText("total $ 1.234.567,00")).toBe(`total ${MASK.amount}`);
    expect(redactFields({ nested: [{ email: "a@b.co" }], count: 12, price: 0.02 })).toEqual({ nested: [{ email: MASK.email }], count: 12, price: MASK.amount });
  });

  it("only reuses a correlation id that looks like one", () => {
    expect(correlationIdFrom("corr-0001-test")).toBe("corr-0001-test");
    expect(correlationIdFrom('x"}\n{"level":"error"')).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFrom(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
