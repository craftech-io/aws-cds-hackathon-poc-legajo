// Explicit re-exports only (no automatic barrel).

export { ChannelMode, ChannelName, ConsoleRole, ErrorCode, SendChannel, Weekday, channelNameOf } from "./enums";

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
