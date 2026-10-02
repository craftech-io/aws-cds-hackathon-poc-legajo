// The one EventBridge Scheduler client of the stage (ADR-0004, docs/architecture.md §8): every timer of
// a world in `RUNNING` has at most one one-time schedule `tm-<w>-<hash>` in the group of the stage,
// `at(<dueAtReal UTC>)`, `FlexibleTimeWindow OFF`, `ActionAfterCompletion DELETE`, target
// `ScheduleDispatch` with the invocation role of infra/scheduler.ts and the timer's `ScheduleInput`.
// Group, role and target come from the linked `Scheduler` (capability TIMERS, `Resource`, never
// `process.env`).
//
// Create, update and delete are idempotent: creating an existing schedule updates it, updating a
// missing one creates it, deleting a missing one is a no-op, so a retried move never fails half way.
// Every call has the SDK's timeout and a retry with backoff on throttling and 5xx; the rest maps to a
// typed `ConnectorError` (`UNAVAILABLE` is retryable upstream, `VALIDATION` is a bug).
import {
  ConflictException,
  CreateScheduleCommand,
  DeleteScheduleCommand,
  ResourceNotFoundException,
  SchedulerClient,
  type SchedulerServiceException,
  UpdateScheduleCommand,
} from "@aws-sdk/client-scheduler";
import { z } from "zod";
import { ConnectorError, parseClockId } from "@legajo/shared";
import { worldOfClock } from "../domain/common";
import { type ClientTimeouts, awsClientConfig } from "../lib/clients";
import { sha256Hex } from "../lib/crypto";
import { readLinked } from "../lib/resource";
import { withRetry } from "../lib/retry";
import { STAGE_REGION } from "../public-web/presign";
import type { ScheduleInput } from "./events";

/** One schedule per timer: what the code asks the Scheduler for. */
export interface ScheduleSpec {
  readonly name: string;
  /** Real instant the schedule fires at (`dueAtSim − offsetMs`, rounded up to the second). */
  readonly at: Date;
  readonly input: ScheduleInput;
}

export interface SchedulerPort {
  /** Creates the schedule, or moves it when it already exists. */
  put(spec: ScheduleSpec): Promise<void>;
  /** Deletes the schedule; a schedule that is already gone (fired or never created) is fine. */
  delete(name: string): Promise<void>;
}

/** `Resource.Scheduler` (infra/scheduler.ts). */
export const SchedulerLink = z.object({ groupName: z.string().min(1), roleArn: z.string().min(1), targetArn: z.string().min(1) });
export type SchedulerLink = z.infer<typeof SchedulerLink>;

/** Schedule names are at most 64 characters (docs/architecture.md §8). */
export const SCHEDULE_NAME_MAX = 64;
const SCHEDULE_NAME_HASH_CHARS = 32;

/** `w` of `tm-<w>-…`: `d` demo, `g` guest, `q` QA (and the fixed QA worlds), `s` metrics batch. */
export function worldLetter(clockId: string): "d" | "g" | "q" | "s" {
  const world = worldOfClock(clockId);
  if (world === "qa") return "q";
  if (world === "guest") return "g";
  return parseClockId(clockId)?.scope === "SIM" ? "s" : "d";
}

/**
 * `tm-<w>-<32 hex>`: one name per timer of a world. Milestone ids repeat across operations
 * (`DOCS_REQUEST`), so the name hashes the world, the operation and the timer key; the world letter
 * stays readable because the QA fence of `DeleteSchedule` is by prefix (`tm-q-*`, `tm-g-*`).
 */
export function scheduleNameOf(clockId: string, operationId: string, timerKey: string): string {
  const name = `tm-${worldLetter(clockId)}-${sha256Hex(`${clockId}#${operationId}#${timerKey}`).slice(0, SCHEDULE_NAME_HASH_CHARS)}`;
  if (name.length > SCHEDULE_NAME_MAX) throw new RangeError(`schedule name ${name} is longer than ${SCHEDULE_NAME_MAX}`);
  return name;
}

/** `at(yyyy-mm-ddThh:mm:ss)` in UTC; a fraction of a second rounds up, so a schedule never fires early. */
export function atExpression(at: Date): string {
  const ms = at.getTime();
  if (Number.isNaN(ms)) throw new RangeError("a schedule needs a valid instant");
  const second = Math.ceil(ms / 1000) * 1000;
  return `at(${new Date(second).toISOString().slice(0, 19)})`;
}

// One schedule call answers in well under a second; a throttled move is retried below.
export const SCHEDULER_TIMEOUTS: ClientTimeouts = { requestTimeoutMs: 3_000, connectionTimeoutMs: 1_000, maxAttempts: 2 };

const RETRYABLE_NAMES: ReadonlySet<string> = new Set(["ThrottlingException", "InternalServerException", "ServiceQuotaExceededException"]);

function mapped(error: unknown, what: string): ConnectorError {
  if (error instanceof ConnectorError) return error;
  const name = (error as Partial<SchedulerServiceException> | undefined)?.name ?? "";
  if (name === "ValidationException") return new ConnectorError("VALIDATION", `${what}: the Scheduler refused the request`, "Scheduler", { cause: error });
  if (name === "TimeoutError" || name === "AbortError") return new ConnectorError("TIMEOUT", `${what}: the Scheduler did not answer`, "Scheduler", { cause: error });
  if (RETRYABLE_NAMES.has(name)) return new ConnectorError("THROTTLED", `${what}: the Scheduler is busy`, "Scheduler", { cause: error });
  return new ConnectorError("UNAVAILABLE", `${what}: the Scheduler failed`, "Scheduler", { cause: error });
}

export interface EventBridgeSchedulerOptions {
  readonly link?: () => SchedulerLink;
  readonly client?: Pick<SchedulerClient, "send">;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The production `SchedulerPort` over `@aws-sdk/client-scheduler`. */
export function eventBridgeScheduler(options: EventBridgeSchedulerOptions = {}): SchedulerPort {
  const link = options.link ?? (() => readLinked("Scheduler", SchedulerLink));
  let client = options.client;
  const scheduler = (): Pick<SchedulerClient, "send"> => (client ??= new SchedulerClient({ region: STAGE_REGION, ...awsClientConfig(SCHEDULER_TIMEOUTS) }));

  async function call<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await withRetry(run, { attempts: 3, ...(options.sleep ? { sleep: options.sleep } : {}), shouldRetry: (error) => RETRYABLE_NAMES.has((error as { name?: string } | undefined)?.name ?? "") });
    } catch (error) {
      throw mapped(error, what);
    }
  }

  function request(spec: ScheduleSpec) {
    const { groupName, roleArn, targetArn } = link();
    return {
      Name: spec.name,
      GroupName: groupName,
      ScheduleExpression: atExpression(spec.at),
      ScheduleExpressionTimezone: "UTC",
      FlexibleTimeWindow: { Mode: "OFF" as const },
      ActionAfterCompletion: "DELETE" as const,
      State: "ENABLED" as const,
      Target: { Arn: targetArn, RoleArn: roleArn, Input: JSON.stringify(spec.input), RetryPolicy: { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 600 } },
    };
  }

  return {
    async put(spec) {
      await call(`schedule ${spec.name}`, async () => {
        try {
          await scheduler().send(new CreateScheduleCommand(request(spec)));
        } catch (error) {
          if (!(error instanceof ConflictException)) throw error;
          await scheduler().send(new UpdateScheduleCommand(request(spec)));
        }
      });
    },

    async delete(name) {
      await call(`delete schedule ${name}`, async () => {
        try {
          await scheduler().send(new DeleteScheduleCommand({ Name: name, GroupName: link().groupName }));
        } catch (error) {
          if (!(error instanceof ResourceNotFoundException)) throw error;
        }
      });
    },
  };
}
