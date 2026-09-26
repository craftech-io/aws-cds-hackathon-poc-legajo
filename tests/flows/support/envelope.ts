// Reading the turn envelope the way the model reads it (docs/design-brief.md §5.2): the scripted
// Harness takes the `sessionToken` of every tool call from `<session token="…"/>` and chooses its
// plan from `<event type=… operation=…/>`, exactly as the real Harness only knows what the worker put
// in the envelope. `testEnvelope` writes the two lines the scripted Harness needs for a turn a test
// opens itself; a turn of the `OperationWorker` carries the worker's own envelope (agent/envelope.ts).
import { TurnTrigger } from "@legajo/shared";

export interface EnvelopeEvent {
  readonly type: TurnTrigger;
  readonly id: string;
  readonly at: string;
  /** Operation number (`4471`), as the envelope names it. */
  readonly operation: string;
}

export interface ReadEnvelope {
  readonly sessionToken: string;
  readonly event: EnvelopeEvent;
  readonly text: string;
}

const SESSION = /^<session token="([^"<>]+)"\/>$/m;
const EVENT = /^<event ([^<>]*)\/>$/m;

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`(?:^|\\s)${name}="([^"<>]*)"`).exec(tag)?.[1];
}

/** The session and event lines of an envelope; throws when either is missing or malformed. */
export function readEnvelope(text: string): ReadEnvelope {
  const sessionToken = SESSION.exec(text)?.[1];
  if (sessionToken === undefined) throw new Error("the turn envelope has no <session token=…/> line");
  const tag = EVENT.exec(text)?.[1];
  if (tag === undefined) throw new Error("the turn envelope has no <event …/> line");
  const type = TurnTrigger.parse(attribute(tag, "type"));
  const id = attribute(tag, "id");
  const at = attribute(tag, "at");
  const operation = attribute(tag, "operation");
  if (id === undefined || at === undefined || operation === undefined) throw new Error("the <event/> line needs id, at and operation");
  return { sessionToken, event: { type, id, at, operation }, text };
}

/** The session and event lines of §5.2 for a turn a test opens itself (no facts, no inbound block). */
export function testEnvelope(input: { readonly sessionToken: string } & EnvelopeEvent): string {
  return `<session token="${input.sessionToken}"/>\n<event type="${input.type}" id="${input.id}" at="${input.at}" operation="${input.operation}"/>`;
}
