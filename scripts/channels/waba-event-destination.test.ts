// `channels:waba-event-destination` (docs/pending.md P-01 step 6): the topic ARN comes from the linked
// WABA's own ARN, a WABA already pointing at it is left alone, and nothing is written without --apply.
import { describe, expect, it } from "vitest";
import { type DestinationDeps, TOPIC_NAME, parseDestinationArgs, runDestination, topicArnFor } from "./waba-event-destination";

const WABA_ARN = "arn:aws:social-messaging:us-east-1:776805327629:waba/waba-1";
const TOPIC_ARN = `arn:aws:sns:us-east-1:776805327629:${TOPIC_NAME}`;

function deps(destinations: string[], wabaId: string | null = "waba-1") {
  const puts: string[] = [];
  const ports: DestinationDeps = {
    get: async () => ({ arn: WABA_ARN, eventDestinations: destinations.map((eventDestinationArn) => ({ eventDestinationArn })) }),
    put: async (_id, topicArn) => void puts.push(topicArn),
    wabaId: () => wabaId ?? undefined,
    report: () => undefined,
  };
  return { ports, puts };
}

describe("channels:waba-event-destination", () => {
  it("derives the topic from the WABA's ARN and refuses anything else", () => {
    expect(topicArnFor(WABA_ARN)).toBe(TOPIC_ARN);
    expect(() => topicArnFor("arn:aws:sns:us-east-1:776805327629:other")).toThrow(RangeError);
    expect(() => parseDestinationArgs(["--apply"])).toThrow(/--stage poc/);
  });

  it("is idempotent and writes only with --apply", async () => {
    expect(await runDestination({ stage: "poc", apply: true }, deps([TOPIC_ARN]).ports)).toBe("ALREADY_SET");
    const plan = deps([]);
    expect(await runDestination(parseDestinationArgs(["--stage", "poc"]), plan.ports)).toBe("WOULD_SET");
    expect(plan.puts).toEqual([]);
    const apply = deps(["arn:aws:sns:us-east-1:776805327629:old"]);
    expect(await runDestination(parseDestinationArgs(["--stage", "poc", "--apply"]), apply.ports)).toBe("SET");
    expect(apply.puts).toEqual([TOPIC_ARN]);
    await expect(runDestination({ stage: "poc" }, deps([], null).ports)).rejects.toThrow(/P-01/);
  });
});
