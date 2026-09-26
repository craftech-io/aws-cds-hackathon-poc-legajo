import { createHash } from "node:crypto";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { ConnectorError } from "@legajo/shared";
import { findAvoidedWord, findSensitiveAsk } from "../copy/forbidden";
import { confirmationPending, uploadPageEsAR } from "./copy";
import { handler } from "./handler";
import { errorPageCsp, escapeHtml, renderErrorPage, renderUploadPage, uploadPageCsp } from "./html";
import { routeOf } from "./http";
import { UPLOAD_PAGE_SCRIPT } from "./page-script";
import { s3PdfPresigner } from "./presign";
import { BUCKET, OPERATION_ID, TOKEN, header, jsonBody, presignFor, publicEvent, publicWebWorld, putLink } from "./testing";

const ORIGIN = `https://${BUCKET}.s3.us-east-1.amazonaws.com`;

function sha256Source(text: string): string {
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

function inline(html: string, tag: "script" | "style"): string {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(html)?.[1] ?? "";
}

function allTexts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [];
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(allTexts);
  return [];
}

describe("upload page HTML and CSP", () => {
  const html = renderUploadPage({ operationNumber: "4471", pending: ["CERTIFICATE_OF_ORIGIN"] });
  const csp = uploadPageCsp(ORIGIN);

  it("allows exactly its own inline script and style by hash, and storage only at the bucket", () => {
    expect(csp).toContain(`script-src ${sha256Source(inline(html, "script"))}`);
    expect(csp).toContain(`style-src ${sha256Source(inline(html, "style"))}`);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(csp.match(/https:\/\/[^\s;]+/g)).toEqual([ORIGIN, ORIGIN]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+stylesheet|style="/);
  });

  it("ships a script that compiles and reads the token only from its own path", () => {
    expect(() => new Function(UPLOAD_PAGE_SCRIPT)).not.toThrow();
    expect(UPLOAD_PAGE_SCRIPT).toContain("window.location.pathname");
    expect(UPLOAD_PAGE_SCRIPT).not.toMatch(/innerHTML|eval\(|document\.write/);
  });

  it("renders error pages without data and without script", () => {
    for (const kind of ["notFound", "expired", "used", "unavailable"] as const) {
      const page = renderErrorPage(kind);
      expect(page).toContain(escapeHtml(uploadPageEsAR.errors[kind].title));
      expect(page).not.toMatch(/<script|Operación|Certificado|Packing|Factura/);
      expect(errorPageCsp()).toContain(`style-src ${sha256Source(inline(page, "style"))}`);
    }
    expect(errorPageCsp()).not.toContain("script-src");
  });

  it("escapes what it interpolates", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });

  it("never asks for sensitive data nor uses the words CONTEXT.md avoids", () => {
    const texts = [...allTexts(uploadPageEsAR), uploadPageEsAR.heading("4471"), confirmationPending([]), confirmationPending(["PACKING_LIST"]), confirmationPending(["PACKING_LIST", "COMMERCIAL_INVOICE"])];
    for (const text of texts) {
      expect(findSensitiveAsk(text), text).toBeUndefined();
      expect(findAvoidedWord(text), text).toBeUndefined();
    }
    expect(confirmationPending(["PACKING_LIST", "COMMERCIAL_INVOICE"])).toBe("Todavía faltan: packing list y factura comercial. Podés volver a este link para subirlos.");
  });
});

describe("upload page edge", () => {
  it("shows nothing of the importer, the supplier or the firm", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const response = await world.handler(publicEvent("GET", `/u/${TOKEN}`));
    expect(response.statusCode).toBe(200);
    for (const other of ["Norpampa", "Lucía", "Benítez", "Qingdao", "Bluewave", "+5491155500101", "@", "firm-delta", "imp-norpampa", "sup-qingdao", "Austral", "QBT-2026", "Delta"]) {
      expect(response.body, other).not.toContain(other);
    }
  });

  it("routes only /u/<token>, its presign and its done", () => {
    expect(routeOf(`/u/${TOKEN}`)).toEqual({ kind: "PAGE", token: TOKEN });
    expect(routeOf(`/u/${TOKEN}/`)).toEqual({ kind: "PAGE", token: TOKEN });
    expect(routeOf(`/u/${TOKEN}/presign`)).toEqual({ kind: "PRESIGN", token: TOKEN });
    expect(routeOf(`/u/${TOKEN}/done`)).toEqual({ kind: "DONE", token: TOKEN });
    for (const path of ["/", "/u", "/u/", `/u/${TOKEN}/other`, `/u/${TOKEN}/presign/x`, `/api/u/${TOKEN}`]) expect(routeOf(path), path).toEqual({ kind: "NONE" });
  });

  it("answers wrong methods and unknown paths without touching the link", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const postToPage = await world.handler(publicEvent("POST", `/u/${TOKEN}`, { body: {} }));
    expect(postToPage.statusCode).toBe(405);
    expect(header(postToPage, "allow")).toBe("GET");
    const getPresign = await world.handler(publicEvent("GET", `/u/${TOKEN}/presign`));
    expect(getPresign.statusCode).toBe(405);
    expect(header(getPresign, "allow")).toBe("POST");
    expect((await world.handler(publicEvent("GET", "/u/whatever/else/here"))).statusCode).toBe(404);
    expect(await world.stores.connector.audit.listByOperation(OPERATION_ID)).toEqual([]);
  });

  it("refuses a POST that is not JSON, comes from another site or does not match its schema", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const body = { docType: "CERTIFICATE_OF_ORIGIN", size: 10, contentType: "application/pdf" };
    const cases: ReadonlyArray<{ headers: Record<string, string>; status: number; reason: string }> = [
      { headers: { "content-type": "text/plain" }, status: 400, reason: "NOT_JSON" },
      { headers: { origin: "https://attacker.example.net" }, status: 403, reason: "CROSS_SITE" },
      { headers: { "sec-fetch-site": "cross-site" }, status: 403, reason: "CROSS_SITE" },
    ];
    for (const { headers, status, reason } of cases) {
      const response = await world.handler(publicEvent("POST", `/u/${TOKEN}/presign`, { body, headers }));
      expect(response.statusCode).toBe(status);
      expect(jsonBody(response)).toMatchObject({ error: { reason } });
    }
    expect((await presignFor(world, "CERTIFICATE_OF_ORIGIN", TOKEN, { extra: true })).statusCode).toBe(400);
    const huge = await world.handler(publicEvent("POST", `/u/${TOKEN}/done`, { body: { keys: ["x".repeat(17_000)] } }));
    expect(jsonBody(huge)).toMatchObject({ error: { reason: "TOO_LARGE" } });
    expect((await world.stores.connector.runtime.getUploadLink(TOKEN))?.presignCount).toBe(0);
    // A base64 body (Function URL) is read like any other.
    const encoded = await world.handler(publicEvent("POST", `/u/${TOKEN}/presign`, { body, base64: true }));
    expect(encoded.statusCode).toBe(200);
  });

  it("answers 503 without the token in any log line when storage fails", async () => {
    const world = await publicWebWorld();
    await putLink(world);
    const failing = await publicWebWorld({
      deps: {
        connector: {
          ...world.stores.connector,
          runtime: {
            ...world.stores.connector.runtime,
            getUploadLink: () => Promise.reject(new ConnectorError("UNAVAILABLE", `Runtime item LINK#${TOKEN}/META timed out`, "Runtime")),
          },
        },
      },
    });
    const page = await failing.handler(publicEvent("GET", `/u/${TOKEN}`));
    expect(page.statusCode).toBe(503);
    expect(page.body).toContain(uploadPageEsAR.errors.unavailable.title);
    const presign = await presignFor(failing, "CERTIFICATE_OF_ORIGIN");
    expect(jsonBody(presign)).toEqual({ ok: false, error: { code: "UNAVAILABLE", reason: "UNAVAILABLE" } });
    const lines = failing.logs();
    expect(lines.filter((line) => line.message === "public_web.failed")).toHaveLength(2);
    expect(JSON.stringify(lines)).not.toContain(TOKEN);
  });

  it("the Lambda entry answers 503 when its resources are not linked", async () => {
    const response = await handler(publicEvent("GET", `/u/${TOKEN}`));
    expect(response.statusCode).toBe(503);
    expect(header(response, "content-security-policy")).toBe(errorPageCsp());
  });

  it("refuses a presigner whose POST would target another origin than the CSP names", async () => {
    const client = new S3Client({ region: "us-east-1", credentials: { accessKeyId: "AKIDTESTPUBLICWEB", secretAccessKey: "test-secret" } });
    const presigner = s3PdfPresigner({ bucket: BUCKET, client, origin: "http://localhost:4566" });
    await expect(presigner.presign(`uploads/${TOKEN}/PACKING_LIST/00000000-0000-4000-8000-000000000001.pdf`)).rejects.toThrow(RangeError);
  });
});
