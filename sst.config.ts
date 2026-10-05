/// <reference path="./.sst/platform/config.d.ts" />

// One stage only (docs/architecture.md §2):
//   poc → npx sst deploy --stage poc  (CI only, GitHub Actions with OIDC; never from a laptop)
//
// There is no `local` stage and `sst dev` is never run: it creates real resources in the shared
// account and would touch the shared Ingress (active receipt rule set, MX records, topic). Anything
// other than `poc` is rejected before a single resource is touched. The SST CLI reports it as
// "Unexpected error occurred"; the actual message is in the config evaluation log (`--print-logs`).

const STAGES = ["poc"] as const;
type Stage = (typeof STAGES)[number];

const REGION = "us-east-1";
const PROJECT = "aws-cds-hackathon-poc-legajo";

function assertStage(stage: string): asserts stage is Stage {
  if (!(STAGES as readonly string[]).includes(stage)) {
    throw new Error(
      `Unknown stage "${stage}". This app only knows the stage ${STAGES.join(" | ")}, deployed only by CI ` +
        `(.github/workflows/deploy.yml). Test locally with vitest and Playwright instead (docs/test-plan.md §2).`,
    );
  }
}

export default $config({
  app(input) {
    assertStage(input.stage);

    // In GitHub Actions the provider takes the credentials of the OIDC role assumed by the
    // workflow; outside CI (secret loading, `sst shell` for the seed) it uses the demos profile.
    const profile = process.env.GITHUB_ACTIONS ? undefined : "craftech-demos";

    // Same map that infra/tags.ts exposes for awsnative.* resources (aws-native has no default
    // tags). Duplicated here because sst.config.ts cannot import local modules outside run(). SST
    // adds `sst:app` and `sst:stage` on its own; they are spelled out because the CI deploy role and
    // the permissions boundary of every role are scoped by `aws:ResourceTag/sst:app`
    // (infra/bootstrap/ci-role.yaml), which must not hang on a default.
    const tags = {
      Project: PROJECT,
      Stage: input.stage,
      ManagedBy: "sst",
      Owner: "craftech",
      "sst:app": PROJECT,
      "sst:stage": input.stage,
    };

    return {
      name: PROJECT,
      home: "aws",
      removal: "remove",
      protect: false,
      version: ">=4.17.1",
      providers: {
        // Pinned on purpose: the AgentCore resources depend on the Cloud Control schema shipped
        // with these versions. Bumping either one requires an ADR.
        aws: {
          version: "7.32.0",
          region: REGION,
          profile,
          defaultTags: { tags },
        },
        "aws-native": {
          version: "1.74.1",
          region: REGION,
          profile,
        },
      },
    };
  },

  async run() {
    // Defaults every Lambda in the app inherits; a module can still override them per function.
    $transform(sst.aws.Function, (args) => {
      args.runtime ??= "nodejs22.x";
      args.architecture ??= "arm64";
      args.logging ??= { retention: "1 month" };
    });

    // Infra modules, in dependency order (docs/build-plan.md §1). Every module exists since WP-02;
    // the stubs export nothing until their work package fills them, so a later wave edits its module
    // and never this list. The one declared exception is the public signup (ADR-0015, WP-51), which
    // adds `leads` (Leads, SignupDispatch, LeadNotice) and `edge-waf` (the web ACL of the Router).
    await import("./infra/tags");
    // Registers the $transform that stamps the IAM path and the CI permissions boundary on every
    // role, so it must come before any module that creates one.
    await import("./infra/ci");
    // Shared sst.Secret declarations (one place); must precede every module that links one.
    await import("./infra/secrets");
    const { channelModes } = await import("./infra/channel-modes");
    await import("./infra/dns"); // WP-04
    await import("./infra/storage"); // WP-06
    await import("./infra/malware"); // WP-06
    await import("./infra/guardrail"); // WP-09
    await import("./infra/policy"); // WP-09
    await import("./infra/auth"); // WP-11
    await import("./infra/messaging-email"); // WP-18
    await import("./infra/leads"); // WP-51: needs auth, storage and the SES senders; before scheduler and bff
    const { whatsappPhoneNumber } = await import("./infra/phone"); // the WhatsApp number and its verification bot
    await import("./infra/messaging-whatsapp"); // WP-21
    await import("./infra/mocks"); // WP-21
    await import("./infra/feeds"); // WP-21
    await import("./infra/agent-tool-schemas"); // WP-22
    await import("./infra/agent-tools"); // WP-23
    const { gateway: agentGateway } = await import("./infra/agentcore"); // WP-23
    const agentGatewayId = agentGateway.gatewayIdentifier;
    await import("./infra/operations"); // WP-24
    await import("./infra/scheduler"); // WP-24
    await import("./infra/bff"); // WP-32
    const { appUrl } = await import("./infra/dns");
    await import("./infra/edge-waf"); // WP-51: the Router of infra/web.ts creates the web ACL with it
    await import("./infra/web"); // WP-04
    await import("./infra/observability"); // WP-32

    return {
      stage: $app.stage,
      region: REGION,
      url: appUrl,
      channels: channelModes,
      whatsappNumber: whatsappPhoneNumber,
      agentGatewayId: agentGatewayId,
    };
  },
});
