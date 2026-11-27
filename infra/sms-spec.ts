// The SMS code of every sign-in session (ADR-0021 §10) as plain data: only the Bff sends it, with SNS
// `Publish` straight to the number. SNS has no ARN for a phone number, so the allow names `*`, and an
// explicit deny of every topic ARN keeps it from ever publishing to a topic (of this app or another
// one of the shared account). The bootstrap's boundary repeats the fence on its side
// (infra/bootstrap/ci-role.yaml `SmsToPhoneNumbersOnly`: Allow sns:Publish with NotResource of topics).
// infra/bff.ts turns these into the Bff's `permissions`; infra/sms-spec.test.ts checks them.
//
// Verify:
//   aws --profile craftech-demos iam simulate-principal-policy --policy-source-arn <Bff role ARN> \
//     --action-names sns:Publish --resource-arns arn:aws:sns:us-east-1:776805327629:any-topic   → explicitDeny
//   aws --profile craftech-demos sns get-sms-attributes   → DefaultSMSType Transactional, MonthlySpendLimit 50

/** Every topic ARN, of any account and region. */
export const SNS_TOPIC_ARNS = "arn:aws:sns:*:*:*";

export interface SmsStatement {
  readonly effect?: "allow" | "deny";
  readonly actions: string[];
  readonly resources: string[];
}

export const SMS_PUBLISH_STATEMENTS: readonly SmsStatement[] = [
  { actions: ["sns:Publish"], resources: ["*"] },
  { effect: "deny", actions: ["sns:Publish"], resources: [SNS_TOPIC_ARNS] },
];

/** The account-wide SMS settings of SNS, declared by hand (docs/architecture.md §17). */
export const SMS_ACCOUNT_SETTINGS = { defaultSmsType: "Transactional", monthlySpendLimitUsd: 50 } as const;
