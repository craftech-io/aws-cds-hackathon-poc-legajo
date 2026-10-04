// The texts a visitor accepts and their versions (ADR-0015 §2 and §8, docs/landing-spec.md §8.2 and
// §8.9): every legal text and consent text is registered here with the version it was published
// under, so changing a word without moving its version in LEGAL_VERSIONS fails; the version each
// page shows on top is the one a lead stores; the privacy policy carries the seven points of
// ADR-0015 §8 and the terms the points of §8.9, in Spanish and English; and the pages stay static.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONSENT_KINDS, CONSENT_REQUIRED, SIGNUP_CONSENT_TEXTS, consentPlainText, legalPageHref } from "./consent-texts";
import { CalendarDate } from "./dates";
import {
  GUEST_QUOTAS,
  GUEST_UPLOAD_MAX_BYTES,
  GUEST_WORLD_IDLE_HOURS,
  GUEST_WORLD_MAX_AGE_HOURS,
  LEAD_RETENTION_DAYS,
  LIVE_CLOCK_MINUTES,
  type LimitWindow,
  MAIL_STATUS_TTL_SECONDS,
  type QuotaKind,
  SIGNUP_PENDING_TTL_SECONDS,
  windowMs,
} from "./guest-limits";
import { LEGAL_PAGE_PATHS, LEGAL_VERSIONS, type LegalDocument, type LegalPage, LegalVersions, isCurrentLegalVersions } from "./legal-versions";
import { readDoc, tableRows } from "./testing";

type TextId = "privacy-page" | "terms-page" | "consent-terms" | "consent-contact";

interface Registered {
  readonly governedBy: LegalDocument;
  /** Append-only: one entry per published version, oldest first. */
  readonly history: readonly { readonly version: string; readonly sha256: string }[];
}

/**
 * Fingerprint of every text a visitor accepts, with the version it was published under. A change of
 * text moves its version in LEGAL_VERSIONS (to the date it takes effect, shown on top of the page)
 * and appends an entry here; an existing entry is never edited.
 */
const REGISTERED: Readonly<Record<TextId, Registered>> = {
  "privacy-page": { governedBy: "privacy", history: [{ version: "2026-10-02", sha256: "82e50eec0159ffb936a95565e86a68004b5a55d56dd993202e535d22cc108a25" }, { version: "2026-10-04", sha256: "fd539d9257e40519b209b98819202c3fd717d32df81f802a43f471b8c3fbc4b6" }] },
  "terms-page": { governedBy: "terms", history: [{ version: "2026-10-02", sha256: "c02dc92d10cb55232c660f9f8d155afbf7da854159a713fead435666d0e096f6" }] },
  "consent-terms": { governedBy: "terms", history: [{ version: "2026-10-02", sha256: "f96deb2e3af4fdd451ce543fd401d36c1f30618b74ec33650c914d0f756454d3" }] },
  "consent-contact": { governedBy: "contact", history: [{ version: "2026-10-02", sha256: "6b6b7602fcfbe42dfc839cf74d9ecc12a27e064c4f208d20bd70e8ef455f1eec" }] },
};

const LANGS = ["es", "en"] as const;
const PAGES: readonly LegalPage[] = ["privacy", "terms"];

function page(name: LegalPage): string {
  return readDoc(`packages/web/public${LEGAL_PAGE_PATHS[name]}`);
}

/** What a reader gets from a page: title and body text, without markup, styles or comments. */
function visibleText(html: string): string {
  return html
    .replace(/\r\n?/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function currentText(id: TextId): string {
  switch (id) {
    case "privacy-page":
      return visibleText(page("privacy"));
    case "terms-page":
      return visibleText(page("terms"));
    case "consent-terms":
      return JSON.stringify(SIGNUP_CONSENT_TEXTS.terms);
    case "consent-contact":
      return JSON.stringify(SIGNUP_CONSENT_TEXTS.contact);
  }
}

/** The `<section id="<lang>">` of a page, which holds the whole document in that language. */
function section(html: string, lang: (typeof LANGS)[number]): string {
  const start = html.indexOf(`<section id="${lang}" lang="${lang}"`);
  const end = html.indexOf("</section>", start);
  if (start === -1 || end === -1) throw new Error(`no <section id="${lang}" lang="${lang}">`);
  return html.slice(start, end);
}

const MONTHS = {
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
} as const;

/** "2026-10-02" → "2 de octubre de 2026" / "2 October 2026". */
function inWords(version: string, lang: (typeof LANGS)[number]): string {
  const [year, month, day] = version.split("-").map(Number);
  const name = MONTHS[lang][(month ?? 1) - 1];
  return lang === "es" ? `${day} de ${name} de ${year}` : `${day} ${name} ${year}`;
}

function isRealDate(value: string): boolean {
  if (!CalendarDate.safeParse(value).success) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

describe("[FL-119] LEGAL_VERSIONS", () => {
  it("dates every text the visitor accepts with a real YYYY-MM-DD and cannot be changed at run time", () => {
    expect(Object.keys(LEGAL_VERSIONS).sort()).toEqual(["contact", "privacy", "terms"]);
    for (const version of Object.values(LEGAL_VERSIONS)) expect(isRealDate(version), version).toBe(true);
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(Object.isFrozen(LEGAL_VERSIONS)).toBe(true);
  });

  it("accepts only the versions in force, with exactly these three keys", () => {
    expect(isCurrentLegalVersions({ ...LEGAL_VERSIONS })).toBe(true);
    expect(isCurrentLegalVersions({ ...LEGAL_VERSIONS, contact: "2020-01-01" })).toBe(false);
    expect(isCurrentLegalVersions({ terms: LEGAL_VERSIONS.terms, privacy: LEGAL_VERSIONS.privacy })).toBe(false);
    expect(isCurrentLegalVersions({ ...LEGAL_VERSIONS, cookies: LEGAL_VERSIONS.terms })).toBe(false);
    expect(isCurrentLegalVersions(undefined)).toBe(false);
    expect(LegalVersions.safeParse({ ...LEGAL_VERSIONS, terms: "02/10/2026" }).success).toBe(false);
  });
});

describe("[FL-119] a text changes only with a new version", () => {
  it.each(Object.keys(REGISTERED) as TextId[])("%s is the text registered with the version in force", (id) => {
    const { governedBy, history } = REGISTERED[id];
    const latest = history.at(-1);
    const actual = sha256(currentText(id));
    expect(latest?.version, `${id}: register LEGAL_VERSIONS.${governedBy} (${LEGAL_VERSIONS[governedBy]}) in REGISTERED`).toBe(LEGAL_VERSIONS[governedBy]);
    expect(
      actual,
      `${id} changed without a new version: move LEGAL_VERSIONS.${governedBy} to the date the text takes effect, show it on the page and append { version, sha256: "${actual}" } to REGISTERED["${id}"]`,
    ).toBe(latest?.sha256);
  });

  it("keeps each history in order, one fingerprint per version", () => {
    for (const [id, { history }] of Object.entries(REGISTERED)) {
      const versions = history.map((entry) => entry.version);
      for (const version of versions) expect(isRealDate(version), `${id} ${version}`).toBe(true);
      expect(versions, id).toEqual([...new Set(versions)].sort());
      for (const entry of history) expect(entry.sha256, id).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("fingerprints the words, not the markup: a style change keeps the hash, a word does not", () => {
    const html = '<p class="a">Acepto <a href="/x">esto</a>.</p>';
    expect(visibleText(html)).toBe("Acepto esto .");
    expect(sha256(visibleText(html.replace('class="a"', 'class="b"')))).toBe(sha256(visibleText(html)));
    expect(sha256(visibleText(html.replace("esto", "aquello")))).not.toBe(sha256(visibleText(html)));
  });
});

describe("[FL-119] each legal page shows on top the version a lead stores", () => {
  it.each(PAGES.flatMap((name) => LANGS.map((lang) => [name, lang] as const)))("%s in %s", (name, lang) => {
    const doc = section(page(name), lang);
    const version = LEGAL_VERSIONS[name];
    const firstHeading = doc.indexOf("<h2");
    const shown = new RegExp(`<strong data-legal-version="${name}">([^<]+)</strong>`).exec(doc);
    expect(shown?.[1]).toBe(version);
    expect(shown?.index ?? Infinity).toBeLessThan(firstHeading);
    expect(doc).toContain(`<time datetime="${version}">${inWords(version, lang)}</time>`);
    expect(doc.indexOf("<time")).toBeLessThan(firstHeading);
  });
});

describe("[FL-089] privacy policy: the seven points of ADR-0015 §8 in Spanish and English", () => {
  const points = ["controller", "data", "purpose", "where", "retention", "rights", "authority"] as const;
  const facts = {
    es: ["Craftech", "Amazon Cognito", "consentimiento", "us-east-1", "transferencia internacional", "arts. 14 a 16", "10 días corridos", "5 días hábiles", "retirar el consentimiento de contacto", "Agencia de Acceso a la Información Pública", "seis meses", "100 % sintéticos"],
    en: ["Craftech", "Amazon Cognito", "consent", "us-east-1", "international transfer", "sections 14 to 16", "10 calendar days", "5 business days", "withdraw the contact consent", "Agencia de Acceso a la Información Pública", "six months", "100% synthetic"],
  } as const;

  it.each(LANGS)("%s", (lang) => {
    const doc = section(page("privacy"), lang);
    for (const point of points) expect(doc, point).toMatch(new RegExp(`<h2 id="${lang}-${point}">`));
    const text = visibleText(doc);
    for (const fact of facts[lang]) expect(text, fact).toContain(fact);
  });
});

describe("[FL-089] terms: free synthetic demo, no warranty, acceptable use, limits and expiry, closing of accounts", () => {
  const points = ["demo", "warranty", "use", "limits", "real", "closing", "ip", "law"] as const;
  const facts = {
    es: ["gratuita", "100 % sintéticos", "Sin garantía", "SLA", "No cargues datos personales reales", "se borra", "cerrar las cuentas", "Craftech"],
    en: ["free", "100% synthetic", "No warranty", "SLA", "Do not load real personal data", "is deleted", "close accounts", "Craftech"],
  } as const;

  it.each(LANGS)("%s", (lang) => {
    const doc = section(page("terms"), lang);
    for (const point of points) expect(doc, point).toMatch(new RegExp(`<h2 id="${lang}-${point}">`));
    const text = visibleText(doc);
    for (const fact of facts[lang]) expect(text, fact).toContain(fact);
  });
});

function limitOf(kind: QuotaKind, window: LimitWindow): number | undefined {
  return GUEST_QUOTAS[kind].find((entry) => entry.window === window)?.limit;
}

const HOUR_SECONDS = 60 * 60;
const MONTH_DAYS = 365 / 12;

/** Every `data-limit` the legal pages show that guest-limits.ts keeps, in the unit the page uses. */
const FROM_GUEST_LIMITS: Readonly<Record<string, number | undefined>> = {
  "world-idle-hours": GUEST_WORLD_IDLE_HOURS,
  "world-max-hours": GUEST_WORLD_MAX_AGE_HOURS,
  "signup-pending-hours": SIGNUP_PENDING_TTL_SECONDS / HOUR_SECONDS,
  "lead-retention-months": Math.round(LEAD_RETENTION_DAYS / MONTH_DAYS),
  "mail-status-months": Math.round(MAIL_STATUS_TTL_SECONDS / (24 * HOUR_SECONDS) / MONTH_DAYS),
  "turns-per-hour": limitOf("AGENT_TURNS", "HOUR"),
  "turns-per-day": limitOf("AGENT_TURNS", "DAY"),
  "emails-per-hour": limitOf("OUTBOUND_EMAILS", "HOUR"),
  "emails-per-day": limitOf("OUTBOUND_EMAILS", "DAY"),
  "phone-per-hour": limitOf("SIMULATOR_MESSAGES", "HOUR"),
  "phone-per-day": limitOf("SIMULATOR_MESSAGES", "DAY"),
  "clock-moves-per-day": limitOf("CLOCK_MOVES", "DAY"),
  "uploads-per-day": limitOf("PDF_UPLOADS", "DAY"),
  "upload-max-mb": GUEST_UPLOAD_MAX_BYTES / (1024 * 1024),
  "operations-per-day": limitOf("NEW_OPERATIONS", "DAY"),
  "reset-every-minutes": windowMs("TEN_MINUTES") / 60_000,
  "resets-per-day": limitOf("WORLD_RESETS", "DAY"),
  "live-clock-minutes": LIVE_CLOCK_MINUTES,
  "live-clock-per-day": limitOf("LIVE_CLOCK", "DAY"),
};

/**
 * Retention promises of ADR-0015 §6 kept by infra rather than by guest-limits.ts: the lifecycle
 * backup of the guest prefixes, the longest life of a rate counter (and of the hashed IP in it) and
 * the log retention.
 */
const RETENTION_IN_INFRA: Readonly<Record<string, number>> = { "world-backup-days": 4, "rate-counter-hours": 48, "log-days": 30 };

describe("[FL-089] usage numbers of the legal pages", () => {
  /** `data-limit` key → every value the pages show for it. */
  function limits(): Map<string, Set<string>> {
    const found = new Map<string, Set<string>>();
    for (const name of PAGES) {
      for (const match of page(name).matchAll(/<span data-limit="([a-z-]+)">([^<]+)<\/span>/g)) {
        const [, key = "", value = ""] = match;
        found.set(key, (found.get(key) ?? new Set()).add(value));
      }
    }
    return found;
  }

  it("say every number the same way in both languages and on both pages", () => {
    const found = limits();
    expect(found.size).toBeGreaterThan(0);
    for (const [key, values] of found) {
      expect([...values], key).toHaveLength(1);
      expect([...values][0], key).toMatch(/^\d+$/);
    }
    const keys = (name: LegalPage, lang: (typeof LANGS)[number]) => [...section(page(name), lang).matchAll(/data-limit="([a-z-]+)"/g)].map((match) => match[1]);
    for (const name of PAGES) expect(keys(name, "en"), name).toEqual(keys(name, "es"));
  });

  it("state the values of guest-limits.ts, and the retention promises of ADR-0015 §6 that live in infra", () => {
    const found = limits();
    for (const [key, values] of found) {
      const expected = FROM_GUEST_LIMITS[key] ?? RETENTION_IN_INFRA[key];
      expect(expected, `${key}: map it to its source`).toBeDefined();
      expect(Number([...values][0]), key).toBe(expected);
    }
    for (const key of [...Object.keys(FROM_GUEST_LIMITS), ...Object.keys(RETENTION_IN_INFRA)]) expect(found.has(key), key).toBe(true);
    // "Uno cada 10 minutos": the ten-minute window of the world resets admits one.
    expect(limitOf("WORLD_RESETS", "TEN_MINUTES")).toBe(1);
  });
});

describe("responsible party of the privacy policy (docs/pending.md P-06)", () => {
  const status = tableRows(readDoc("docs/pending.md"), "| # | Pendiente |").find((cells) => cells[0] === "P-06")?.[3] ?? "";
  const open = !/^Cerrado el \d{4}-\d{2}-\d{2}/.test(status);
  const markers = (html: string) => [...html.matchAll(/data-pending="P-06"/g)].length;

  it("marks the legal name, address and privacy mailbox as pending in both languages exactly while P-06 is open", () => {
    expect(status).not.toBe("");
    for (const lang of LANGS) expect(markers(section(page("privacy"), lang)), lang).toBe(open ? 3 : 0);
    expect(markers(page("terms"))).toBe(0);
    if (!open) for (const name of PAGES) expect(page(name), name).not.toMatch(/data-pending=/);
  });
});

describe("[FL-089] static pages that fit the console's CSP", () => {
  it.each(PAGES)("%s", (name) => {
    const html = page(name);
    expect(html).toMatch(/^<!doctype html>\n<html lang="es">/);
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toMatch(/<section id="es" lang="es"[ >]/);
    expect(html).toMatch(/<section id="en" lang="en"[ >]/);
    expect(html).not.toMatch(/<script|<iframe|<form|\son[a-z]+=|\sstyle=/i);
    const references = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const reference of references) expect(reference.startsWith("/") || reference.startsWith("#") || reference === "https://craftech.io", reference).toBe(true);
    for (const reference of references.filter((value) => value.startsWith("/legal/"))) {
      const [path = "", fragment] = reference.split("#");
      const target = readDoc(`packages/web/public${path}`);
      if (fragment !== undefined) expect(target, reference).toContain(`id="${fragment}"`);
    }
    for (const fragment of references.filter((value) => value.startsWith("#"))) expect(html, fragment).toContain(`id="${fragment.slice(1)}"`);
  });
});

describe("[FL-119] consent texts of the sign-up form", () => {
  it("has both boxes in Spanish and English, terms required and contact optional", () => {
    expect([...CONSENT_KINDS]).toEqual(["terms", "contact"]);
    expect(CONSENT_REQUIRED).toEqual({ terms: true, contact: false });
    for (const kind of CONSENT_KINDS) {
      for (const lang of LANGS) {
        expect(SIGNUP_CONSENT_TEXTS[kind][lang].length, `${kind} ${lang}`).toBeGreaterThan(0);
        for (const run of SIGNUP_CONSENT_TEXTS[kind][lang]) expect(run.text, `${kind} ${lang}`).not.toBe("");
        expect(consentPlainText(kind, lang), `${kind} ${lang}`).toMatch(/\.$/);
      }
    }
    expect(consentPlainText("terms", "es")).toBe("Acepto los términos y la política de privacidad.");
    expect(consentPlainText("contact", "en")).toBe("I agree that Craftech may contact me about this solution.");
  });

  it("links the terms box to both legal pages, in the language of the form, and the contact box to none", () => {
    for (const lang of LANGS) {
      expect(SIGNUP_CONSENT_TEXTS.terms[lang].flatMap((run) => (run.link ? [run.link] : []))).toEqual(["terms", "privacy"]);
      expect(SIGNUP_CONSENT_TEXTS.contact[lang].some((run) => run.link !== undefined)).toBe(false);
      for (const name of PAGES) {
        const href = legalPageHref(name, lang);
        expect(href).toBe(`${LEGAL_PAGE_PATHS[name]}#${lang}`);
        expect(page(name)).toContain(`<section id="${lang}" lang="${lang}"`);
      }
    }
  });
});
