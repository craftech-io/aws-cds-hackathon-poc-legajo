// Explicit re-exports only (no automatic barrel). Every package imports from "@legajo/shared";
// "@legajo/shared/<module>" also resolves for callers that want a single module.

export {
  APPROVER_ROLES,
  AgentMode,
  Channel,
  ChannelMode,
  ChannelName,
  ConsoleRole,
  ErrorCode,
  FirmKind,
  Language,
  MailAwaiting,
  MetricSource,
  ReferenceType,
  SendChannel,
  SenderProfile,
  Weekday,
  World,
  canApprove,
  channelNameOf,
} from "./enums";

export {
  AgentEscalationReason,
  ConversationControl,
  CustomsChannel,
  DispatchStatus,
  DocStatus,
  DocType,
  DocumentSourceChannel,
  DossierStatus,
  EscalationReason,
  MatrixResponsible,
  ObservationCode,
  ObservationSeverity,
  ObservationStatus,
  Party,
  ReadingMatchedBy,
  ReadingStatus,
} from "./enums-dossier";

export {
  ConsentMedium,
  MessageDirection,
  MessageKind,
  SendStatus,
  SupplierBehaviour,
  SupplierContactStatus,
  SupplierEmailKind,
  WaButtonAction,
  WhatsAppTemplateName,
} from "./enums-messaging";

export {
  AuditDecision,
  ClockMode,
  Guardrail,
  GuardrailAction,
  GuardrailOrigin,
  GuardrailOutcome,
  GuardrailSource,
  MilestoneName,
  OperationEventType,
  PendingKind,
  TimerFiredBy,
  TimerKind,
  TimerStatus,
  TurnTrigger,
} from "./enums-runtime";

export { GATEWAY_TOOLS, GatewayToolName, ToolTarget, gatewayActionName, toolTargetOf } from "./tools";

export {
  CEDAR_STATEMENT_IDS,
  CONTACT_POLICY_RULES,
  CedarStatementId,
  ContactPolicyRuleId,
  LAMBDA_FENCE_IDS,
  LambdaFenceId,
  OTHER_RULE_IDS,
  PolicyResult,
  RuleId,
  cedarPermitId,
  cedarSessionId,
  isRuleId,
} from "./rules";

export {
  BrokerId,
  ContactId,
  DOC_TYPE_SHORT,
  DocVersionId,
  FirmId,
  ID_PREFIX,
  ID_SPEC,
  ImporterId,
  MessageId,
  OPERATION_NUMBER_RANGES,
  ObservationId,
  OperationId,
  OperationNumber,
  SupplierId,
  SyntheticDocId,
  docTypeFromShort,
  docVersionId,
  idSchema,
  isId,
  kindOfId,
  makeId,
  observationId,
  operationId,
  operationKey,
  operationNumberOf,
  operationNumberRange,
  padVersion,
  parseSyntheticDocId,
  syntheticDocId,
  versionTag,
} from "./ids";
export type { DocTypeShort, IdKind, IdPrefix, OperationNumberRange } from "./ids";

export {
  ClockId,
  ClockScope,
  JUDGE_TEST_CLOCK_ID,
  QA_FIRM_IDS,
  QA_GLOBAL_CLOCK_ID,
  clockScopeOf,
  globalClockId,
  judgeClockId,
  parseClockId,
  qaClockId,
  simClockId,
} from "./clock-ids";
export type { ParsedClockId } from "./clock-ids";

export {
  NOTICES_ADDRESS,
  QA_INJECTOR_PREFIX,
  QA_PARTY_PREFIX,
  SES_MAILBOX_SIMULATOR_DOMAIN,
  SIM_MAIL_DOMAIN,
  STAGE_DOMAIN,
  THREAD_TAG_LENGTH,
  ThreadTag,
  computeThreadTag,
  isReservedDomain,
  parseThreadAddress,
  threadAddress,
  threadTagMessage,
  verifyThreadTag,
} from "./addresses";
export type { ThreadTagInput } from "./addresses";

export {
  SIM_MEDIA_REF_PREFIX,
  WorldTemplateName,
  documentsKeys,
  mediaKeys,
  parseSimMediaKey,
  parseSimMediaRef,
  parseUploadKey,
  seedKeys,
  simMediaRef,
  uploadsKeys,
  worldKey,
} from "./document-keys";
export type { SimMediaKey, UploadKey } from "./document-keys";

export {
  Caller,
  CallerKind,
  PrincipalInput,
  QaConsoleRole,
  SESSION_TOKEN_MAX_TTL_SECONDS,
  SESSION_TOKEN_PATTERN,
  SessionToken,
  isSessionTokenExpired,
  principalKind,
  splitSessionToken,
} from "./caller";
export type { SessionTokenParts } from "./caller";

export { FLOW_AREAS, FlowArea, FlowId, FlowLevel, ScenarioId, ScenarioStepRef, expandStepRef, flowTag, flowTagsIn } from "./flows";

export {
  CalendarDate,
  IsoInstant,
  addBusinessDays,
  addCalendarDays,
  businessDaysBetween,
  compareDates,
  formatDate,
  isBusinessDay,
  isWeekend,
  nextBusinessDay,
  weekStart,
  weekdayOf,
} from "./dates";

export {
  addressHash,
  hmacSha256,
  hmacSha256Hex,
  isHexHash,
  maskDocument,
  maskEmail,
  maskPhone,
  normalizeAddress,
  normalizeEmail,
  normalizePhone,
  sha256Hex,
} from "./hash";

export {
  ChannelError,
  ChannelErrorCode,
  ConnectorError,
  ConnectorErrorCode,
  ERROR_REASON,
  ToolError,
  ToolErrorSchema,
  ToolFailureSchema,
  fail,
  isRetryable,
  ok,
  toToolFailure,
} from "./errors";
export type { ErrorReason, ToolErrorShape, ToolFailure, ToolOk, ToolResult } from "./errors";

export {
  AuthorizationSetInput,
  CONSOLE_CHANGE_INPUTS,
  CONSOLE_REASON_MAX,
  CONSOLE_TEXT_MAX,
  ClassifyDocumentInput,
  ClockResetInput,
  ConsentRecordInput,
  ConsentRevokeInput,
  ContactConfirmInput,
  ContactUpsertInput,
  ConversationControlInput,
  ConversationSendInput,
  CountryCodeInput,
  DossierApproveInput,
  DossierReopenInput,
  E164Phone,
  EmailInput,
  ImporterUpsertInput,
  SupplierBehaviourSetInput,
  SupplierUpsertInput,
  WaiveObservationInput,
  isConsoleChangePath,
} from "./console-inputs";
export type { ConsoleChangeInputs, ConsoleChangePath } from "./console-inputs";
