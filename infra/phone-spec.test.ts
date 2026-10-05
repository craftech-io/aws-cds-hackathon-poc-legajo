import { describe, expect, it } from "vitest";
import { OTP_LANGUAGES, OTP_POLICY, PREFIXES, jobNameOf } from "../packages/bff/src/phone/otp";
import { OTP_LIMITS, PHONE_PREFIXES, TRANSCRIBE_JOB_PREFIX, TRANSCRIBE_LANGUAGES, WHATSAPP_NUMBER, connectInstanceAlias, otpFlowContent, transcribeJobArn } from "./phone-spec";

interface FlowAction {
  readonly Identifier: string;
  readonly Type: string;
  readonly Parameters: Record<string, unknown>;
  readonly Transitions: { readonly NextAction?: string; readonly Errors?: ReadonlyArray<{ readonly NextAction: string }> };
}

describe("[PH-03] the WhatsApp number and its verification flow", () => {
  it("names the Connect instance within the alias rules (45 characters, letters, digits and single hyphens)", () => {
    const alias = connectInstanceAlias("aws-cds-hackathon-poc-legajo", "poc");
    expect(alias).toBe("aws-cds-hackathon-poc-legajo-poc");
    expect(connectInstanceAlias("a".repeat(60), "poc")).toHaveLength(45);
    expect(alias).toMatch(/^(?!d-)[\dA-Za-z]+(-[\dA-Za-z]+)*$/);
    expect(WHATSAPP_NUMBER).toEqual({ countryCode: "US", type: "DID" });
  });

  it("records from the first block, listens in silence and hangs up on every path", () => {
    const flow = JSON.parse(otpFlowContent()) as { StartAction: string; Actions: FlowAction[] };
    const byId = new Map(flow.Actions.map((action) => [action.Identifier, action]));
    expect(byId.get(flow.StartAction)?.Parameters).toEqual({ RecordingBehavior: { RecordedParticipants: [], IVRRecordingBehavior: "Enabled" } });
    expect(flow.Actions.map((action) => action.Type)).toEqual(["UpdateContactRecordingBehavior", "GetParticipantInput", "DisconnectParticipant"]);
    expect(flow.Actions[1]?.Parameters["InputTimeLimitSeconds"]).toBe(String(OTP_LIMITS.listenSeconds));
    expect(flow.Actions.some((action) => action.Type === "MessageParticipant")).toBe(false);
    const targets = flow.Actions.flatMap((action) => [action.Transitions.NextAction, ...(action.Transitions.Errors ?? []).map((error) => error.NextAction)]).filter((target) => target !== undefined);
    for (const target of targets) expect(byId.has(target), target).toBe(true);
  });

  it("keeps the bot's prefixes, languages, limits and job names in step with the infra", () => {
    expect(Object.values(PHONE_PREFIXES).map((prefix) => `${prefix}/`)).toEqual([PREFIXES.recordings, PREFIXES.transcripts, PREFIXES.attempts]);
    expect([...OTP_LANGUAGES]).toEqual([...TRANSCRIBE_LANGUAGES]);
    expect(OTP_POLICY).toEqual({ maxFailedCalls: OTP_LIMITS.maxFailedCalls, windowHours: OTP_LIMITS.windowHours });
    expect(jobNameOf("c1").startsWith(TRANSCRIBE_JOB_PREFIX)).toBe(true);
    expect(transcribeJobArn({ account: "776805327629", region: "us-east-1" })).toBe("arn:aws:transcribe:us-east-1:776805327629:transcription-job/otp-*");
  });
});
