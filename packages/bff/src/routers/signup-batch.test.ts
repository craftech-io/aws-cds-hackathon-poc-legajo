// FL-113 (f): a `signup.*` hidden in a batch, behind another procedure or behind an encoded route is
// refused with 400 by the first step of the handler, before anything runs (ADR-0015 §3.1).
import { beforeEach, describe, expect, it } from "vitest";
import type { MemoryStores } from "../connector/index";
import { memoryStores } from "../connector/testing";
import { RUNTIME_TABLE } from "../signup/counters";
import { type TestAccess, testAccessDeps } from "../signup/testing";
import { validForm } from "../signup/testing-flows";
import { type Bff, bffFor, call, trpcEvent } from "../signup/testing-http";

let stores: MemoryStores;
let access: TestAccess;
let bff: Bff;

beforeEach(() => {
  stores = memoryStores();
  access = testAccessDeps(stores);
  bff = bffFor(stores, access);
});

function nothingRan(): void {
  expect(access.invoker.invoked).toEqual([]);
  expect(stores.client.dump(RUNTIME_TABLE)).toEqual([]);
  expect(access.cognito.calls).toEqual([]);
}

describe("[FL-113] no sign-up in a batch", () => {
  it.each([
    ["behind another procedure in a batch", "/api/account.usage,signup.start", "batch=1"],
    ["behind another procedure under /api/trpc", "/api/trpc/account.usage,signup.start", "batch=1"],
    ["with another sign-up procedure", "/api/signup.form,signup.start", "batch=1"],
    ["alone but asking for a batch", "/api/signup.start", "batch=1"],
    ["in a batch without the batch parameter", "/api/signup.form,signup.start", ""],
    ["encoded in the route", "/api/signup%2Estart", ""],
    ["encoded behind another procedure", "/api/account.usage%2Csignup%2Estart", "batch=1"],
    ["with another case", "/api/account.usage,SIGNUP.start", "batch=1"],
  ])("%s → 400 before anything runs", async (_label, path, query) => {
    const result = await call(bff, trpcEvent("POST", path, { input: { 0: validForm(access), 1: validForm(access) }, query }));
    expect(result.status).toBe(400);
    expect(result.error).toMatchObject({ reason: "BATCH_NOT_ALLOWED" });
    nothingRan();
  });

  it("a batch of console procedures still goes through (and asks for a token)", async () => {
    const result = await call(bff, trpcEvent("GET", "/api/account.usage,clock.get", { query: "batch=1&input=%7B%7D" }));
    expect(result.status).not.toBe(400);
    expect(result.status).toBe(401);
  });
});
