// EventBridge Scheduler for the timers, and WorldJanitor (docs/architecture.md §8, §9.3 and §14,
// ADR-0004, ADR-0007, docs/build-plan.md WP-24).
//
// Timers. Everything due at a simulated hour is a `TIMER#` item (ADR-0004). A world that runs in real
// time (`RUNNING`) gives each timer due within the next real hour at most one one-time schedule
// `tm-<w>-<timerId>` (`at()`, FlexibleTimeWindow OFF, ActionAfterCompletion DELETE), which the code
// holding TIMERS creates, moves and deletes at runtime (packages/bff/src/timers, WP-27). A paused
// world has none. This module creates what those schedules need and nothing that fires by itself:
//
//   Schedules group        `<app>-<stage>-schedules`: the fence of `scheduler:*` for the code (TIMERS),
//                          for the CI deploy role and for the permissions boundary (bootstrap).
//   scheduler-invoke role  `<app>-<stage>-scheduler-invoke`: every timer schedule runs with it. Trusted
//                          only by scheduler.amazonaws.com for this account and this group; its only
//                          permission is lambda:InvokeFunction on ScheduleDispatch.
//   ScheduleDispatch       target of every schedule, input {clockId, operationId, timerKey, dueAtSim,
//                          version}: checks the timer's version and enqueues TIMER on
//                          OperationEvents.fifo, or hands SIM_REPLY to SimMail (docs/architecture.md §7).
//   Scheduler (Linkable)   capability TIMERS: `Resource.Scheduler.{groupName, roleArn, targetArn}`, the
//                          four schedule actions on the group's schedules and iam:PassRole of the
//                          invocation role, only towards scheduler.amazonaws.com.
//
// WorldJanitor. The world factory's background worker (capability WORLDS, Platform fenced to
// POP#firm-guest-* by infra/mocks.ts) and the sweeper of the public signup (ADR-0015 §5: LEADS,
// SIGNUP_ADMIN, LEAD_NOTICE and GUEST_CLEANUP, applied with `signupGrants("WorldJanitor")` of
// infra/leads.ts). Its entries:
//   - MEMORY_PURGE, invoked asynchronously by Bff and QaDriver after "Reiniciar demo" or world.destroy:
//     the second pass and the listings of the Memory purge, up to 10 minutes (docs/architecture.md
//     §9.3), hence the 12-minute timeout. Its resource policy names those two roles; within one
//     account an identity policy alone also invokes, so the fence that counts is that no other role
//     of the app holds lambda:InvokeFunction on it (infra/iam-capabilities.ts).
//   - GUEST_SWEEP every hour: UNCONFIRMED users without groups older than 24 h, verified signups to
//     finalize, PENDING lead notices, the 24-month retention of leads and (WP-31) expired public guest
//     worlds.
//   - The nightly reset of reserved guest worlds idle for 24 real hours, at 04:00 ART
//     (docs/architecture.md §8): cron(0 7 * * ? *) in UTC, since Argentina keeps UTC−3 all year. The
//     rule exists DISABLED until WP-31 makes the handler accept IDLE_GUEST_RESET and enables it.
//   Both are EventBridge rules on the default bus (`sst.aws.Cron`), not Scheduler schedules: the CI
//   deploy role creates tagged rules, while schedules are created only by the code, inside the group.
//
// Cost: per schedule invocation and per Lambda run; nothing bills while every world is paused.
//
// Verify:
//   aws --profile craftech-demos scheduler get-schedule-group --name aws-cds-hackathon-poc-legajo-poc-schedules
//   aws --profile craftech-demos scheduler list-schedules --group-name aws-cds-hackathon-poc-legajo-poc-schedules
//     → empty while every world is PAUSED
//   aws --profile craftech-demos iam get-role --role-name aws-cds-hackathon-poc-legajo-poc-scheduler-invoke
//     → Path /aws-cds-hackathon-poc-legajo/, PermissionsBoundary …-ci-boundary, trust scheduler.amazonaws.com
//       with aws:SourceAccount and the group as aws:SourceArn
//   aws --profile craftech-demos lambda get-policy --function-name <WorldJanitor name>
//     → events.amazonaws.com from the nightly rule, and the Bff and QaDriver roles
//   aws --profile craftech-demos events list-rule-names-by-target --target-arn <WorldJanitor ARN>
//     → the hourly GUEST_SWEEP rule (rate(1 hour), ENABLED) and the nightly rule (cron(0 7 * * ? *),
//       DISABLED until WP-31)

import { CAPABILITIES, type LambdaName } from "./iam-capabilities";
import { lateLinks, links } from "./late-links";
import { signupGrants } from "./leads";
import { simMail } from "./messaging-email";
import { mockLinks, mockPermissions } from "./mocks";
import { OperationEvents } from "./operations";
import { SeedOverrides, SessionTokenKey } from "./secrets";
import { storageLinks } from "./storage";

export const SCHEDULER_SERVICE = "scheduler.amazonaws.com";

/** The group every timer schedule of the stage lives in (docs/architecture.md §8). */
export function scheduleGroupName(app: string, stage: string): string {
  return `${app}-${stage}-schedules`;
}

/** The role every timer schedule of the stage runs with. */
export function schedulerInvocationRoleName(app: string, stage: string): string {
  return `${app}-${stage}-scheduler-invoke`;
}

/**
 * Fixed physical name of ScheduleDispatch. The invocation role and the Scheduler Linkable derive its ARN
 * from the name instead of waiting for the function: ScheduleDispatch links SimMail and SimMail links
 * Scheduler, so taking the ARN from the resource is a cycle Pulumi never resolves (the first deploy of
 * poc ended with leaked promises and no error).
 */
export function scheduleDispatchName(app: string, stage: string): string {
  return `${app}-${stage}-schedule-dispatch`;
}

/** TIMERS on the group's schedules; `iam:PassRole` is granted apart, conditioned on the service. */
export const SCHEDULE_ACTIONS: readonly string[] = CAPABILITIES.TIMERS.actions.filter((action) => action.startsWith("scheduler:"));

/** Lambda entries; each file belongs to the WP that writes the code (docs/build-plan.md §2). */
export const SCHEDULER_HANDLERS = {
  ScheduleDispatch: "packages/bff/src/handlers/schedule-dispatch.handler", // WP-29
  WorldJanitor: "packages/bff/src/handlers/world-janitor.handler", // WP-31
} as const satisfies Partial<Record<LambdaName, string>>;

export const WORLD_JANITOR = {
  /** The Memory purge may list for 10 minutes after its 60-second second pass (docs/architecture.md §9.3). */
  timeoutSeconds: 12 * 60,
  /** 04:00 ART = 07:00 UTC; EventBridge rules run in UTC. */
  nightlySchedule: "cron(0 7 * * ? *)",
  /** Input of the nightly run (packages/bff/src/handlers/world-janitor.ts validates it with zod). */
  nightlyEvent: { kind: "IDLE_GUEST_RESET" },
  /** Disabled until WP-31: today the handler accepts MEMORY_PURGE and GUEST_SWEEP only. */
  nightlyEnabled: false,
  /** The signup and guest-world sweep (ADR-0015 §5). */
  guestSweepSchedule: "rate(1 hour)",
  guestSweepEvent: { kind: "GUEST_SWEEP" },
} as const;

/** Callers of the asynchronous MEMORY_PURGE, by the export of infra/bff.ts (WP-32) that creates each one. */
export const MEMORY_PURGE_INVOKERS = { Bff: "bff", QaDriver: "qaDriver" } as const satisfies Partial<Record<LambdaName, string>>;

/**
 * Linkables of infra/agentcore.ts, taken late (infra/late-links.ts, mode `required`).
 * `Agent`: `Resource.Agent.memoryId` and MEMORY_ADMIN on the stage's Memory (worlds/memory-admin.ts).
 */
export const SCHEDULER_LATE_LINKS = { agentcore: ["Agent"] } as const;

/** Trust of the invocation role: the Scheduler of this account, for schedules of this group only. */
export function schedulerTrustDocument(accountId: string, groupArn: string): object {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Principal: { Service: SCHEDULER_SERVICE },
        Action: "sts:AssumeRole",
        Condition: { StringEquals: { "aws:SourceAccount": accountId, "aws:SourceArn": groupArn } },
      },
    ],
  };
}

/** The invocation role's only permission. */
export function schedulerInvokeDocument(targetArn: string): object {
  return {
    Version: "2012-10-17",
    Statement: [{ Sid: "InvokeScheduleDispatchOnly", Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [targetArn] }],
  };
}

const accountId = aws.getCallerIdentityOutput({}).accountId;
const region = aws.getRegionOutput({}).region;

// ---- Timers ----------------------------------------------------------------------------------------

export const scheduleGroup = new aws.scheduler.ScheduleGroup("Schedules", { name: scheduleGroupName($app.name, $app.stage) });

const scheduleDispatchArn = $interpolate`arn:aws:lambda:${region}:${accountId}:function:${scheduleDispatchName($app.name, $app.stage)}`;

export const scheduleDispatch = new sst.aws.Function("ScheduleDispatch", {
  description: "Target of every timer schedule: checks the timer's version and enqueues TIMER, or hands SIM_REPLY to SimMail.",
  handler: SCHEDULER_HANDLERS.ScheduleDispatch,
  timeout: "30 seconds",
  memory: "256 MB",
  // Linking SimMail grants lambda:InvokeFunction on it and nothing else.
  link: [...storageLinks("ScheduleDispatch"), OperationEvents, simMail],
  transform: {
    function: (args) => {
      args.name = scheduleDispatchName($app.name, $app.stage);
    },
  },
});

export const schedulerInvocationRole = new aws.iam.Role("SchedulerInvocationRole", {
  name: schedulerInvocationRoleName($app.name, $app.stage),
  description: "Assumed by EventBridge Scheduler for the timer schedules of the app's group; invokes ScheduleDispatch only.",
  assumeRolePolicy: $util.all([accountId, scheduleGroup.arn]).apply(([account, groupArn]) => JSON.stringify(schedulerTrustDocument(account, groupArn))),
});

export const schedulerInvocationPolicy = new aws.iam.RolePolicy("SchedulerInvocationPolicy", {
  role: schedulerInvocationRole.id,
  policy: scheduleDispatchArn.apply((arn) => JSON.stringify(schedulerInvokeDocument(arn))),
});

const groupSchedules = $interpolate`arn:aws:scheduler:${region}:${accountId}:schedule/${scheduleGroup.name}/*`;

/** Capability TIMERS: `Resource.Scheduler.{groupName, roleArn, targetArn}` and the permissions to program a timer. */
export const Scheduler = new sst.Linkable("Scheduler", {
  properties: {
    groupName: scheduleGroup.name,
    roleArn: schedulerInvocationRole.arn,
    targetArn: scheduleDispatchArn,
  },
  include: [
    sst.aws.permission({ actions: [...SCHEDULE_ACTIONS], resources: [groupSchedules] }),
    sst.aws.permission({
      actions: ["iam:PassRole"],
      resources: [schedulerInvocationRole.arn],
      conditions: [{ test: "StringEquals", variable: "iam:PassedToService", values: [SCHEDULER_SERVICE] }],
    }),
  ],
});

// ---- WorldJanitor ----------------------------------------------------------------------------------

/** Leads, LeadNotice, the pool and the guest objects (infra/leads.ts, docs/architecture.md §14). */
const janitorSignup = signupGrants("WorldJanitor");

export const worldJanitor = new sst.aws.Function("WorldJanitor", {
  description: "Memory purge of a reset or destroyed world, hourly sweep of the public signup and guest worlds, nightly reset of reserved guests.",
  handler: SCHEDULER_HANDLERS.WorldJanitor,
  timeout: `${WORLD_JANITOR.timeoutSeconds} seconds`,
  // Reloads world templates from Seed and rewrites every item of a world.
  memory: "512 MB",
  link: links(
    // WORLDS: its tables, Seed and Media, Platform's name (never the table: its statement comes from
    // mockPermissions), the timers, and the key that derives a new epoch's hashes and thread tags.
    [...storageLinks("WorldJanitor"), ...mockLinks("WorldJanitor"), Scheduler, SessionTokenKey, SeedOverrides, ...janitorSignup.link],
    lateLinks("scheduler", "agentcore", () => import("./agentcore"), SCHEDULER_LATE_LINKS.agentcore),
  ),
  permissions: [...mockPermissions("WorldJanitor"), ...janitorSignup.permissions],
});

export const worldJanitorNightly = new sst.aws.Cron("WorldJanitorNightly", {
  function: worldJanitor.arn,
  schedule: WORLD_JANITOR.nightlySchedule,
  event: WORLD_JANITOR.nightlyEvent,
  enabled: WORLD_JANITOR.nightlyEnabled,
});

export const worldJanitorGuestSweep = new sst.aws.Cron("WorldJanitorGuestSweep", {
  function: worldJanitor.arn,
  schedule: WORLD_JANITOR.guestSweepSchedule,
  event: WORLD_JANITOR.guestSweepEvent,
});

/**
 * Resource policy of WorldJanitor for MEMORY_PURGE: one permission per calling role. infra/bff.ts
 * creates both callers and is evaluated after this module (and imports it), so they are resolved
 * late; until it exports them the deploy warns and the policy names only the nightly rule.
 */
export const worldJanitorPurgeInvokers = $util.output(
  import("./bff").then((module) =>
    (Object.entries(MEMORY_PURGE_INVOKERS) as Array<[string, string]>).flatMap(([caller, exportName]) => {
      const created: unknown = Reflect.get(module, exportName);
      if (!(created instanceof sst.aws.Function)) {
        $util.log.warn(`infra/bff.ts exports no ${exportName} yet: WorldJanitor's resource policy does not name the ${caller} role.`);
        return [];
      }
      return [
        new aws.lambda.Permission(`WorldJanitorPurgeBy${caller}`, {
          action: "lambda:InvokeFunction",
          function: worldJanitor.name,
          principal: created.nodes.role.arn,
        }),
      ];
    }),
  ),
);
