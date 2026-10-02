// guest-limits.ts is the single source of the numbers of ADR-0015 §3.2 and §4. These tests read the
// ADR's own tables and compare them with the constants, so a number changed on one side only fails
// here; no number is written in this file.
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_EMAIL_LIMITS,
  CONFIRM_MAX_ATTEMPTS,
  GUEST_QUOTAS,
  GUEST_SLOTS,
  GUEST_WORLD_CREATING_STALE_MINUTES,
  GUEST_WORLD_IDLE_HOURS,
  GUEST_WORLD_MAX_AGE_HOURS,
  type LimitWindow,
  MAIL_BREAKER,
  PUBLIC_GLOBAL_BUDGET,
  QuotaExceededKind,
  QuotaKind,
  RESEND_MAX_PER_SIGNUP,
  RESEND_WAIT_SECONDS,
  SIGNUP_RATE_LIMITS,
  SLOT_RELEASE_COOLDOWN_MINUTES,
  type WindowedLimit,
  windowBucket,
  windowEnd,
  windowMs,
} from "./guest-limits";
import { readDoc, tableRows } from "./testing";

const ADR = readDoc("docs/adr/0015-alta-publica-de-invitados-y-leads.md");

/** "5 por hora y 20 por día", "1 cada 10 min, 12 por día", "3 por 24 h" → windowed limits. */
function limitsIn(cell: string): WindowedLimit[] {
  const out: WindowedLimit[] = [];
  for (const match of cell.replaceAll(".", "").matchAll(/(\d+) (?:por|cada) (hora|día|24 h|10 min)/g)) {
    const window: LimitWindow = match[2] === "hora" ? "HOUR" : match[2] === "10 min" ? "TEN_MINUTES" : "DAY";
    out.push({ window, limit: Number(match[1]) });
  }
  return out;
}

function rowStartingWith(rows: readonly string[][], prefix: string): string[] {
  const row = rows.find((cells) => (cells[0] ?? "").startsWith(prefix));
  if (row === undefined) throw new Error(`row not found: ${prefix}`);
  return row;
}

describe("sign-up limits of ADR-0015 §3.2", () => {
  const rows = tableRows(ADR, "| Alcance | Tope | Al superarlo");
  const limitOf = (prefix: string) => limitsIn(rowStartingWith(rows, prefix)[1] ?? "");

  it("per IP, per email, per domain and in total", () => {
    expect(limitOf("`signup.start` por IP")).toEqual(SIGNUP_RATE_LIMITS.startPerIp);
    expect(limitOf("`signup.start` por email")).toEqual(SIGNUP_RATE_LIMITS.startPerEmail);
    expect(limitOf("Altas por dominio")).toEqual(SIGNUP_RATE_LIMITS.startPerDomain);
    expect(limitOf("Altas nuevas en total")).toEqual(SIGNUP_RATE_LIMITS.startTotal);
  });

  it("resend, confirm and the account emails", () => {
    const resend = rowStartingWith(rows, "`signup.resend`")[1] ?? "";
    expect(resend).toContain(`${RESEND_WAIT_SECONDS} s entre reenvíos`);
    expect(resend).toContain(`${RESEND_MAX_PER_SIGNUP} por \`signupId\``);
    const confirm = rowStartingWith(rows, "`signup.confirm`")[1] ?? "";
    expect(confirm).toContain(`${CONFIRM_MAX_ATTEMPTS} códigos errados`);
    expect(limitsIn(confirm)).toEqual(SIGNUP_RATE_LIMITS.confirmPerIp);
    expect(limitOf("Emails de cuenta por destinatario")).toEqual(ACCOUNT_EMAIL_LIMITS.perRecipient);
    expect(limitOf("Emails de cuenta por dominio")).toEqual(ACCOUNT_EMAIL_LIMITS.perDomain);
    expect(limitOf("Emails de cuenta en total")).toEqual(ACCOUNT_EMAIL_LIMITS.total);
  });

  it("the reputation breaker", () => {
    expect(ADR).toContain(`las quejas llegan a **${MAIL_BREAKER.complaintCount}**`);
    expect(ADR).toContain(`superan el **${MAIL_BREAKER.badRate * 100} %** con al menos ${MAIL_BREAKER.minSent} emails`);
    expect(ADR).toContain(`últimas ${MAIL_BREAKER.lookbackHours} h`);
  });
});

describe("guest worlds of ADR-0015 §4", () => {
  const rows = tableRows(ADR, "| Tipo | Tope");
  const quotaRow: Readonly<Record<Exclude<QuotaKind, never>, string>> = {
    AGENT_TURNS: "Turnos del agente",
    OUTBOUND_EMAILS: "Emails salientes",
    SIMULATOR_MESSAGES: "Mensajes del simulador",
    CLOCK_MOVES: "Movimientos del reloj",
    PDF_UPLOADS: "Cargas de PDF",
    NEW_OPERATIONS: "Operaciones nuevas",
    WORLD_RESETS: "Reinicios del mundo",
    LIVE_CLOCK: "\"Reloj en vivo\"",
    WORLD_PREPARATIONS: "Llamados a `account.ensureWorld`",
  };

  it.each(QuotaKind.options)("%s has the windows and limits of the table", (kind) => {
    expect(limitsIn(rowStartingWith(rows, quotaRow[kind])[1] ?? "")).toEqual(GUEST_QUOTAS[kind]);
  });

  it("the global budget of the public worlds counts turns and emails per day", () => {
    const budget = rowStartingWith(rows, "**Presupuesto global")[1] ?? "";
    expect(budget).toContain(`${(PUBLIC_GLOBAL_BUDGET.AGENT_TURNS ?? 0).toLocaleString("es-AR")} turnos`);
    expect(budget).toContain(`${(PUBLIC_GLOBAL_BUDGET.OUTBOUND_EMAILS ?? 0).toLocaleString("es-AR")} emails`);
    expect(QuotaExceededKind.options).toEqual([...QuotaKind.options, "GLOBAL"]);
  });

  it("slots, lease cooldown, stale creation and TTL", () => {
    const pad = (n: number) => String(n).padStart(2, "0");
    expect(ADR).toContain(`\`${pad(GUEST_SLOTS.reserved.first)}–${GUEST_SLOTS.reserved.last}\` reservados`);
    expect(ADR).toContain(`\`${GUEST_SLOTS.public.first}–${GUEST_SLOTS.public.last}\` públicos: **${GUEST_SLOTS.public.last - GUEST_SLOTS.public.first + 1} mundos públicos activos como máximo**`);
    expect(ADR).toContain(`hace **al menos ${SLOT_RELEASE_COOLDOWN_MINUTES} min**`);
    expect(ADR).toContain(`de hace más de **${GUEST_WORLD_CREATING_STALE_MINUTES} min**`);
    expect(ADR).toContain(`**${GUEST_WORLD_IDLE_HOURS} h reales sin actividad**`);
    expect(ADR).toContain(`**${GUEST_WORLD_MAX_AGE_HOURS} h reales de creado**`);
  });
});

describe("windows", () => {
  const at = new Date("2026-10-14T13:27:41.000Z");

  it("buckets are fixed UTC slices", () => {
    expect(windowBucket("DAY", at)).toBe("2026-10-14");
    expect(windowBucket("HOUR", at)).toBe("2026-10-14T13");
    expect(windowBucket("TEN_MINUTES", at)).toBe("2026-10-14T13:20Z");
  });

  it("a window ends where the next bucket starts", () => {
    expect(windowEnd("DAY", at).toISOString()).toBe("2026-10-15T00:00:00.000Z");
    expect(windowEnd("HOUR", at).toISOString()).toBe("2026-10-14T14:00:00.000Z");
    expect(windowEnd("TEN_MINUTES", at).toISOString()).toBe("2026-10-14T13:30:00.000Z");
    expect(windowEnd("HOUR", new Date(windowEnd("HOUR", at).getTime() - 1)).getTime()).toBe(windowEnd("HOUR", at).getTime());
    for (const window of ["TEN_MINUTES", "HOUR", "DAY"] as const) expect(windowEnd(window, at).getTime() - at.getTime()).toBeLessThanOrEqual(windowMs(window));
  });
});
