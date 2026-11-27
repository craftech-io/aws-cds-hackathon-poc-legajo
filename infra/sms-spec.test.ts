// ADR-0021 §10: `sns:Publish` only for the Bff, and only to phone numbers.
import { describe, expect, it } from "vitest";
import { LAMBDA_CAPABILITIES, expectedActions, type LambdaName } from "./iam-capabilities";
import { SMS_PUBLISH_STATEMENTS, SNS_TOPIC_ARNS } from "./sms-spec";
import { read, statement } from "./bootstrap/template-text";

describe("[FL-134] the SMS of the code", () => {
  it("is sent by the Bff alone", () => {
    const holders = (Object.keys(LAMBDA_CAPABILITIES) as LambdaName[]).filter((fn) => expectedActions(fn).includes("sns:Publish"));
    expect(holders).toEqual(["Bff"]);
  });

  it("allows Publish on * only next to an explicit deny of every topic", () => {
    expect(SMS_PUBLISH_STATEMENTS).toEqual([
      { actions: ["sns:Publish"], resources: ["*"] },
      { effect: "deny", actions: ["sns:Publish"], resources: [SNS_TOPIC_ARNS] },
    ]);
    expect(SNS_TOPIC_ARNS).toBe("arn:aws:sns:*:*:*");
    expect(read("infra/bff.ts")).toContain("...SMS_PUBLISH_STATEMENTS");
  });

  it("is fenced by the boundary too: Publish with NotResource of topics, never sns:* on *", () => {
    const fence = statement("SmsToPhoneNumbersOnly");
    expect(fence).toContain("Effect: Allow");
    expect(fence).toContain("Action: sns:Publish");
    expect(fence).toContain('NotResource: !Sub "arn:${AWS::Partition}:sns:*:*:*"');
    expect(fence).not.toMatch(/^\s*Resource:/m);
  });
});
