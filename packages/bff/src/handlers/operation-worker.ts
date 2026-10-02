// Lambda entry of `OperationWorker` (docs/architecture.md §7), which infra/operations.ts subscribes to
// `OperationEvents.fifo` (batch 1, reserved concurrency 5, visibility 720 s, `maxReceiveCount 2`). The
// worker itself is worker/worker.ts; its dependencies are built on the first invocation of a container
// (worker/production.ts), so importing this module reads nothing.
import type { SQSEvent } from "aws-lambda";
import { type LambdaContextLike, type OperationWorker, createOperationWorker } from "../worker/worker";
import { productionWorkerDeps } from "../worker/production";

let worker: OperationWorker | undefined;

export async function handler(event: SQSEvent, context?: LambdaContextLike): Promise<void> {
  worker ??= createOperationWorker(productionWorkerDeps());
  await worker(event, context);
}
