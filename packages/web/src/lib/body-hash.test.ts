import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONTENT_SHA256_HEADER, sha256Hex, withBodyHash } from "./body-hash";

const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function nodeSha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("body hash for origin access control (ADR-0015 §3.1)", () => {
  it("is the hex SHA-256 of the exact bytes, UTF-8 included", async () => {
    const body = JSON.stringify({ "0": { email: "nadie@sim.legajo.demo.craftech.io", name: "Martín Núñez" } });
    expect(await sha256Hex(body)).toBe(nodeSha256(body));
    expect(await sha256Hex(new TextEncoder().encode(body))).toBe(nodeSha256(body));
    expect(await sha256Hex(undefined)).toBe(EMPTY);
    expect(await sha256Hex("")).toBe(EMPTY);
  });

  it("signs every POST and leaves GET requests alone", async () => {
    const body = '{"0":{"signupId":"x"}}';
    const signed = await withBodyHash("/api/signup.resend", { method: "POST", body, headers: { "content-type": "application/json" } });
    const headers = new Headers(signed?.headers);
    expect(headers.get(CONTENT_SHA256_HEADER)).toBe(nodeSha256(body));
    expect(headers.get("content-type")).toBe("application/json");

    const get = { method: "GET" } satisfies RequestInit;
    expect(await withBodyHash("/api/clock.get", get)).toBe(get);
    expect(await withBodyHash("/api/clock.get", undefined)).toBeUndefined();
  });

  it("signs a POST without a body with the empty digest and refuses a body it cannot read", async () => {
    const empty = await withBodyHash("/api/x", { method: "POST" });
    expect(new Headers(empty?.headers).get(CONTENT_SHA256_HEADER)).toBe(EMPTY);
    await expect(withBodyHash("/api/x", { method: "POST", body: new FormData() })).rejects.toThrow(TypeError);
  });
});
