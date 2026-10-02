// Where captures may be taken (FL-129, ADR-0016 §4): only https://legajo.demo.craftech.io (or a
// subdomain) with nothing but the origin, refused before a browser starts; on the stage only the app,
// Cognito of its region and the pre-signed S3 reads go through; locally, only the local server.
import { describe, expect, it } from "vitest";
import { STAGE_URL, localRequestAllowed, parseBaseUrl, parseCaptureArgs, stageRequestAllowed } from "./capture-target";


describe("capture target [FL-129]", () => {
  it("takes the stage by default and accepts only its origin or a subdomain's, over https", () => {
    expect(parseBaseUrl(undefined)).toBe(STAGE_URL);
    expect(parseBaseUrl("https://legajo.demo.craftech.io/")).toBe("https://legajo.demo.craftech.io");
    expect(parseBaseUrl("https://preview.legajo.demo.craftech.io")).toBe("https://preview.legajo.demo.craftech.io");
    for (const refused of ["http://legajo.demo.craftech.io", "https://evil.example.com", "https://legajo.demo.craftech.io.evil.com", "https://xlegajo.demo.craftech.io", "https://legajo.demo.craftech.io:8443", "https://user:pw@legajo.demo.craftech.io", "https://legajo.demo.craftech.io/app", "https://legajo.demo.craftech.io/?x=1", "not a url"]) {
      expect(() => parseBaseUrl(refused), refused).toThrow(/--base-url/);
    }
  });

  it("parses the command line and refuses a base URL for a local capture", () => {
    expect(parseCaptureArgs(["--target", "local", "--only", "console-audit, console-metrics"])).toEqual({ target: "local", baseUrl: STAGE_URL, only: new Set(["console-audit", "console-metrics"]), out: undefined });
    expect(() => parseCaptureArgs(["--target", "local", "--base-url", STAGE_URL])).toThrow(/--target poc only/);
    expect(() => parseCaptureArgs([])).toThrow(/--target/);
  });

  it("lets through, on the stage, only the app, Cognito of the region and S3's pre-signed reads", () => {
    const allowed = stageRequestAllowed(STAGE_URL);
    expect(allowed(new URL("https://legajo.demo.craftech.io/api/trpc/operations.list"))).toBe(true);
    expect(allowed(new URL("https://cognito-idp.us-east-1.amazonaws.com/"))).toBe(true);
    expect(allowed(new URL("https://documents-bucket.s3.us-east-1.amazonaws.com/a.pdf?X-Amz-Signature=x"))).toBe(true);
    expect(allowed(new URL("https://sts.amazonaws.com/"))).toBe(false);
    expect(allowed(new URL("https://cognito-idp.eu-west-1.amazonaws.com/"))).toBe(false);
    expect(allowed(new URL("https://fonts.googleapis.com/css"))).toBe(false);
    expect(allowed(new URL("http://cognito-idp.us-east-1.amazonaws.com/"))).toBe(false);
  });

  it("lets a local capture reach only the local server", () => {
    const allowed = localRequestAllowed("http://127.0.0.1:4310");
    expect(allowed(new URL("http://127.0.0.1:4310/app/operations"))).toBe(true);
    expect(allowed(new URL("http://127.0.0.1:4311/"))).toBe(false);
    expect(allowed(new URL("https://legajo.demo.craftech.io/"))).toBe(false);
  });
});
