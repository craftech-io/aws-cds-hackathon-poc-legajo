import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const INFRA = join(import.meta.dirname);
const sources = readdirSync(INFRA)
  .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
  .map((file) => ({ file, text: readFileSync(join(INFRA, file), "utf8") }));

describe("permission resources (infra/output-arns.ts)", () => {
  it("never passes one Output holding the whole ARN array: SST drops it and IAM rejects the statement", () => {
    const offenders = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/resources:\s*(?:\$util\s*\.|[A-Za-z_$][\w$.]*\.apply\()/g)].map((match) => `${file}: ${match[0]}`),
    );
    expect(offenders).toEqual([]);
  });
});
