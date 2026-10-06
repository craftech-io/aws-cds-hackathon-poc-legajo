// The user message of a turn (docs/design-brief.md §5.2): an envelope written by code, never free
// text from the edge.
//
//   <session token="…"/>                                       signed session token of the turn
//   <event type="SUPPLIER_EMAIL" id="evt_…" at="…-03:00" operation="4471"/>
//   <facts>…</facts>                                           state of the dossier, one fact per line
//   <inbound-7f3a9c channel="EMAIL" from-role="SUPPLIER" trusted="true" truncated="false">
//     …normalized, masked text with < > & " ' escaped…
//   </inbound-7f3a9c>
//   <attachment docVersion="dv-4471-PL-1" readingStatus="RECOGNIZED" docType="PACKING_LIST" observations="1"/>
//   <tool-result tool="get_dossier">{…}</tool-result>         a read the worker already ran in this turn (ADR-0019)
//
// Every value that is not a fixed word of this module is escaped, the untrusted text sits inside the
// turn's random delimiter (channels/normalizer.ts `untrustedBlock`), so an importer or a supplier can
// never close the block and forge an `<event>`, `<facts>` or `<session>`. File names, subjects and PDF
// metadata never reach this module: of a PDF only the reader's structured result does (ADR-0003).
// Pure on purpose: turns/envelope.ts gathers the inputs from the connector.
import { Channel, DocType, DocVersionId, OperationNumber, ReadingStatus, SESSION_TOKEN_PATTERN, TurnTrigger } from "@legajo/shared";
import { EVENT_ID_PATTERN } from "../channels/adapter";
import { TURN_DELIMITER_PATTERN, escapeUntrusted, untrustedBlock } from "../channels/normalizer";

/** Who wrote the untrusted text: a party, or the firm whose messages a `BROKER_RELEASED` turn summarizes. */
export type InboundRole = "IMPORTER" | "SUPPLIER" | "BROKER";

export interface EnvelopeEvent {
  readonly type: TurnTrigger;
  /** `eventId` of the `AGENT_TURN` that opened the turn. */
  readonly id: string;
  /** Simulated instant of the event, ISO 8601 with the Argentina offset. */
  readonly at: string;
  /** Public operation number (`4471`). */
  readonly operation: string;
}

export type FactValue = string | number | boolean;

/** One line of `<facts>`: a name and its attributes, all rendered escaped. */
export interface FactLine {
  readonly name: string;
  readonly attributes: Readonly<Record<string, FactValue>>;
}

export interface InboundBlock {
  /** `inbound-<6 hex>`, the same the turn's system prompt names. */
  readonly delimiter: string;
  /** Already normalized and masked by channels/normalizer.ts (and by G1, when it anonymized). */
  readonly text: string;
  readonly channel: Channel;
  readonly fromRole: InboundRole;
  readonly trusted: boolean;
  readonly truncated: boolean;
}

export interface AttachmentLine {
  readonly docVersionId: string;
  readonly docType: DocType;
  /** The reader's status; `PENDING` while the version has no reading yet. */
  readonly readingStatus: ReadingStatus | "PENDING";
  readonly observations: number;
}

export interface EnvelopeInput {
  readonly sessionToken: string;
  readonly event: EnvelopeEvent;
  readonly facts: readonly FactLine[];
  readonly inbound?: InboundBlock;
  readonly attachments?: readonly AttachmentLine[];
  readonly preloaded?: readonly PreloadedResult[];
}

/** A read tool the worker ran with the turn's token before the Harness (ADR-0019): the tool's own answer. */
export interface PreloadedResult {
  readonly tool: string;
  readonly output: unknown;
}

/** At most this many attachment lines (one turn answers one inbound or one upload link). */
export const MAX_ENVELOPE_ATTACHMENTS = 20;

const FACT_NAME = /^[a-z][a-zA-Z0-9-]{0,31}$/;
const ATTRIBUTE_NAME = /^[a-zA-Z][a-zA-Z0-9-]{0,31}$/;

function attributes(values: Readonly<Record<string, FactValue>>): string {
  return Object.entries(values)
    .map(([name, value]) => {
      if (!ATTRIBUTE_NAME.test(name)) throw new RangeError(`invalid envelope attribute "${name}"`);
      return ` ${name}="${escapeUntrusted(String(value))}"`;
    })
    .join("");
}

function sessionLine(token: string): string {
  if (!SESSION_TOKEN_PATTERN.test(token)) throw new RangeError("the envelope needs a well-formed session token");
  return `<session token="${token}"/>`;
}

function eventLine(event: EnvelopeEvent): string {
  TurnTrigger.parse(event.type);
  if (!EVENT_ID_PATTERN.test(event.id)) throw new RangeError("the envelope event needs an event id");
  OperationNumber.parse(event.operation);
  if (Number.isNaN(Date.parse(event.at))) throw new RangeError("the envelope event needs an instant");
  return `<event${attributes({ type: event.type, id: event.id, at: event.at, operation: event.operation })}/>`;
}

function factsBlock(facts: readonly FactLine[]): string {
  const lines = facts.map((fact) => {
    if (!FACT_NAME.test(fact.name)) throw new RangeError(`invalid fact name "${fact.name}"`);
    return `${fact.name}${attributes(fact.attributes)}`;
  });
  return ["<facts>", ...lines, "</facts>"].join("\n");
}

function attachmentLine(attachment: AttachmentLine): string {
  DocVersionId.parse(attachment.docVersionId);
  DocType.parse(attachment.docType);
  if (!Number.isInteger(attachment.observations) || attachment.observations < 0) throw new RangeError("observations must be a count");
  return `<attachment${attributes({ docVersion: attachment.docVersionId, readingStatus: attachment.readingStatus, docType: attachment.docType, observations: attachment.observations })}/>`;
}

function inboundBlock(inbound: InboundBlock): string {
  if (!TURN_DELIMITER_PATTERN.test(inbound.delimiter)) throw new RangeError("not a turn delimiter");
  return untrustedBlock(inbound.delimiter, inbound.text, {
    channel: Channel.parse(inbound.channel),
    "from-role": inbound.fromRole,
    trusted: inbound.trusted,
    truncated: inbound.truncated,
  });
}

const TOOL_NAME = /^[a-z][a-z_]{0,40}$/;

/**
 * The tool's JSON with `<`, `>` and `&` as JSON escapes: still the same JSON to read, and no value the
 * tool returned (a reading from a PDF, a name) can close the element or open another one.
 */
function preloadedLine(result: PreloadedResult): string {
  if (!TOOL_NAME.test(result.tool)) throw new RangeError(`invalid preloaded tool "${result.tool}"`);
  const json = JSON.stringify(result.output).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  return `<tool-result tool="${result.tool}">${json}</tool-result>`;
}

/** The envelope text of a turn. Throws on a malformed fixed part: a bug, never a message. */
export function renderEnvelope(input: EnvelopeInput): string {
  const attachments = input.attachments ?? [];
  if (attachments.length > MAX_ENVELOPE_ATTACHMENTS) throw new RangeError(`at most ${MAX_ENVELOPE_ATTACHMENTS} attachment lines`);
  return [
    sessionLine(input.sessionToken),
    eventLine(input.event),
    factsBlock(input.facts),
    ...(input.inbound === undefined ? [] : [inboundBlock(input.inbound)]),
    ...attachments.map(attachmentLine),
    ...(input.preloaded ?? []).map(preloadedLine),
  ].join("\n");
}
