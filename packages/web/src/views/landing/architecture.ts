// The architecture diagram of "Cómo funciona por dentro": six layers read top to bottom, each node an AWS
// service with its official architecture icon (public/landing/aws/, from the MIT `aws-icons` package) or
// one of the firm's own systems, which carry an icon of the landing instead. The texts live in the copy
// (`architecture.nodes`), keyed by the ids below.
import type { IconName } from "./icons";

export type ArchitectureLayerId = "parties" | "edge" | "flow" | "agent" | "data" | "systems";

export type ArchitectureNodeId =
  | "importer"
  | "supplier"
  | "broker"
  | "eumSocial"
  | "ses"
  | "edge"
  | "cognito"
  | "sqs"
  | "worker"
  | "scheduler"
  | "agent"
  | "tools"
  | "dynamodb"
  | "s3"
  | "guardduty"
  | "reader"
  | "platform";

export type NodeVisual = { readonly aws: string } | { readonly icon: IconName };

export interface ArchitectureLayer {
  readonly id: ArchitectureLayerId;
  readonly nodes: ReadonlyArray<{ readonly id: ArchitectureNodeId; readonly visual: NodeVisual }>;
}

const aws = (file: string): NodeVisual => ({ aws: `/landing/aws/${file}.svg` });

export const ARCHITECTURE: readonly ArchitectureLayer[] = [
  {
    id: "parties",
    nodes: [
      { id: "importer", visual: { icon: "chat" } },
      { id: "supplier", visual: { icon: "envelope" } },
      { id: "broker", visual: { icon: "personCheck" } },
    ],
  },
  {
    id: "edge",
    nodes: [
      { id: "eumSocial", visual: aws("AWSEndUserMessaging") },
      { id: "ses", visual: aws("AmazonSimpleEmailService") },
      { id: "edge", visual: aws("AmazonCloudFront") },
      { id: "cognito", visual: aws("AmazonCognito") },
    ],
  },
  {
    id: "flow",
    nodes: [
      { id: "sqs", visual: aws("AmazonSimpleQueueService") },
      { id: "worker", visual: aws("AWSLambda") },
      { id: "scheduler", visual: aws("AmazonEventBridge") },
    ],
  },
  {
    id: "agent",
    nodes: [
      { id: "agent", visual: aws("AmazonBedrockAgentCore") },
      { id: "tools", visual: aws("AWSLambda") },
    ],
  },
  {
    id: "data",
    nodes: [
      { id: "dynamodb", visual: aws("AmazonDynamoDB") },
      { id: "s3", visual: aws("AmazonSimpleStorageService") },
      { id: "guardduty", visual: aws("AmazonGuardDuty") },
    ],
  },
  {
    id: "systems",
    nodes: [
      { id: "reader", visual: { icon: "reader" } },
      { id: "platform", visual: { icon: "documents" } },
    ],
  },
];
