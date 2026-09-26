import { describe, expect, it } from "vitest";
import { parseFlags } from "./cli-args";

describe("parseFlags", () => {
  it("hands each flag its value and repeats a flag as often as it is given", () => {
    const firms: string[] = [];
    let apply = false;
    parseFlags(["--firm", "firm-delta", "--apply", "--firm", "firm-norte"], {
      "--firm": (value) => {
        firms.push(value());
      },
      "--apply": () => {
        apply = true;
      },
    });
    expect(firms).toEqual(["firm-delta", "firm-norte"]);
    expect(apply).toBe(true);
  });

  it("refuses a flag without its value and a flag it does not know", () => {
    const handlers = { "--stage": (value: () => string) => void value() };
    expect(() => parseFlags(["--stage"], handlers)).toThrow('--stage needs a value');
    expect(() => parseFlags(["--stage", "--apply"], handlers)).toThrow('--stage needs a value');
    expect(() => parseFlags(["--stag", "poc"], handlers)).toThrow('unknown argument "--stag"');
    expect(() => parseFlags(["toString"], handlers)).toThrow('unknown argument "toString"');
  });
});
