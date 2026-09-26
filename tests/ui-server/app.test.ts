import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createTestIssuer } from "@legajo/bff/auth/testing";
import { linkFixture } from "@legajo/bff/public-web/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_BUCKETS, type UiApp, createUiApp } from "./app";

const POOL = { userPoolId: "us-east-1_e2eLegajo", clientId: "e2e-console-client" };
const DIEGO_SUB = "0b7f0e2e-0000-4000-8000-000000000001";
const PDF = new Uint8Array(Buffer.from("%PDF-1.4\n% synthetic test document\n%%EOF\n"));

describe("local UI server", () => {
  const issuer = createTestIssuer({ kid: "legajo-e2e-ephemeral" });
  let server: Server;
  let app: UiApp;
  let origin: string;

  const token = () =>
    issuer.idToken({
      sub: DIEGO_SUB,
      iss: `https://cognito-idp.us-east-1.amazonaws.com/${POOL.userPoolId}`,
      aud: POOL.clientId,
      "cognito:groups": ["BROKER"],
      "custom:firmId": "firm-delta",
      "custom:role": "BROKER",
      email: undefined,
    });

  beforeAll(async () => {
    server = createServer((request, response) => {
      void app.handle(request, response).then((handled) => {
        if (!handled) response.writeHead(404).end("vite");
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    app = await createUiApp({ origin, pool: POOL, jwks: issuer.jwks });
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("runs the real appRouter with the run's key and refuses a request without a token", async () => {
    const answer = await fetch(`${origin}/api/clock.get`, { headers: { authorization: `Bearer ${token()}` } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ result: { data: { clockId: "GLOBAL#firm-delta", mode: "PAUSED", busy: false } } });
    expect((await fetch(`${origin}/api/clock.get`)).status).toBe(401);
    const batch = await fetch(`${origin}/api/account.session,operations.list?batch=1&input=${encodeURIComponent("{}")}`, { headers: { authorization: `Bearer ${token()}` } });
    const [session, list] = (await batch.json()) as Array<{ result: { data: Record<string, unknown> } }>;
    expect(session?.result.data).toMatchObject({ firm: { name: "Estudio Delta" }, role: "BROKER" });
    expect((list?.result.data.operations as unknown[]).length).toBe(1);
  });

  it("hands everything else to Vite", async () => {
    expect(await (await fetch(`${origin}/login`)).text()).toBe("vite");
  });

  it("serves the upload page and takes a presigned POST only as S3 would", async () => {
    const link = await app.stores.connector.runtime.putUploadLink(linkFixture({ expiresAtReal: new Date(Date.now() + 3_600_000).toISOString() }));
    const page = await fetch(`${origin}/u/${link.token}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(origin);

    const presign = await fetch(`${origin}/u/${link.token}/presign`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ docType: "PACKING_LIST", size: PDF.byteLength, contentType: "application/pdf" }),
    });
    expect(presign.status).toBe(200);
    const post = (await presign.json()) as { url: string; key: string; fields: Record<string, string> };
    expect(post.url).toBe(`${origin}/s3/${LOCAL_BUCKETS.uploads}`);

    const send = (fields: Record<string, string>, file: Uint8Array) => {
      const form = new FormData();
      for (const [name, value] of Object.entries(fields)) form.append(name, value);
      form.append("file", new Blob([Buffer.from(file)], { type: fields["Content-Type"] ?? "" }));
      return fetch(post.url, { method: "POST", body: form });
    };
    expect((await send({ ...post.fields, "Content-Type": "text/html" }, PDF)).status).toBe(403);
    expect((await send({ ...post.fields, key: `${post.key}.other` }, PDF)).status).toBe(403);
    expect((await send({ ...post.fields, Policy: Buffer.from('{"expiration":"2099-01-01T00:00:00Z","conditions":[]}').toString("base64") }, PDF)).status).toBe(403);
    expect((await send(post.fields, new Uint8Array(0))).status).toBe(400);
    expect(app.objects.keys(LOCAL_BUCKETS.uploads)).toEqual([]);

    expect((await send(post.fields, PDF)).status).toBe(204);
    expect(app.objects.keys(LOCAL_BUCKETS.uploads)).toEqual([post.key]);
  });
});
