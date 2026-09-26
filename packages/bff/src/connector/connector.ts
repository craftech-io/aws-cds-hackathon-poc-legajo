// The `Connector` port and its one implementation: the repositories of dynamo/*.ts composed over a
// TableClient. Over the DocumentClient it is the DynamoDB adapter; over the in-memory client it is
// the test and local-flow adapter. Same code either way.
import { auditRepo } from "./dynamo/audit";
import { conversationsRepo } from "./dynamo/conversations";
import { documentsRepo } from "./dynamo/documents";
import { firmsRepo } from "./dynamo/firms";
import { metricsRepo } from "./dynamo/metrics";
import { operationsRepo } from "./dynamo/operations";
import { partiesRepo } from "./dynamo/parties";
import { referenceRepo } from "./dynamo/reference";
import type { RepoContext } from "./dynamo/repo";
import { runtimeRepo } from "./dynamo/runtime";
import { timersRepo } from "./dynamo/timers";
import { worldStateRepo } from "./dynamo/world-state";
import type { DocumentsPort, FirmsPort, OperationsPort, PartiesPort, TimersPort } from "./ports";
import type { AuditPort, ConversationsPort, MetricsPort, ReferencePort, RuntimePort, WorldPort } from "./ports-runtime";

export interface Connector {
  readonly firms: FirmsPort;
  readonly parties: PartiesPort;
  readonly operations: OperationsPort;
  readonly documents: DocumentsPort;
  readonly timers: TimersPort;
  readonly conversations: ConversationsPort;
  readonly audit: AuditPort;
  readonly reference: ReferencePort;
  readonly runtime: RuntimePort;
  readonly world: WorldPort;
  readonly metrics: MetricsPort;
}

export function createConnector(ctx: RepoContext): Connector {
  return {
    firms: firmsRepo(ctx),
    parties: partiesRepo(ctx),
    operations: operationsRepo(ctx),
    documents: documentsRepo(ctx),
    timers: timersRepo(ctx),
    conversations: conversationsRepo(ctx),
    audit: auditRepo(ctx),
    reference: referenceRepo(ctx),
    runtime: runtimeRepo(ctx),
    world: worldStateRepo(ctx),
    metrics: metricsRepo(ctx),
  };
}
