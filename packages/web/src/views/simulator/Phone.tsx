// The simulated phone of one importer: a frame that always says it is a simulator, the chat with the
// firm grouped by simulated day, "El agente está escribiendo…" while a turn runs on one of the
// thread's operations, and the composer. The list of threads beside it highlights the ones with
// messages the importer has not read.
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Bubble } from "./Bubble";
import { Composer } from "./Composer";
import { simulatorCopy } from "./copy";
import type { SimButton, SimMessage, SimThread, SimulatorAction } from "./simulator-api";
import { byDay, phoneMessages } from "./simulator-model";

const copy = simulatorCopy;

interface ThreadListProps {
  readonly threads: readonly SimThread[];
  readonly current: string | undefined;
  readonly onOpen: (importerId: string) => void;
}

export function ThreadList({ threads, current, onOpen }: ThreadListProps) {
  return (
    <nav aria-label={copy.threads.title} className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold tracking-wide text-slate uppercase">{copy.threads.title}</h2>
      {threads.length === 0 ? <p className="text-sm text-slate">{copy.threads.empty}</p> : null}
      <ul className="flex flex-col gap-2">
        {threads.map((thread) => {
          const active = thread.importerId === current;
          const unread = thread.unread > 0;
          return (
            <li key={thread.importerId}>
              <button
                type="button"
                aria-current={active ? "true" : undefined}
                title={copy.threads.open(thread.importerName)}
                className={`w-full rounded-card border px-4 py-3 text-left ${active ? "border-cyan bg-cyan-soft" : unread ? "border-warning bg-warning-soft" : "border-mist bg-white hover:bg-paper"}`}
                onClick={() => onOpen(thread.importerId)}
              >
                <span className="block font-medium text-navy">{thread.importerName}</span>
                <span className="block text-xs text-slate">
                  {thread.contactName} · {copy.threads.operations(thread.operations.map((operation) => operation.operationNumber))}
                </span>
                {unread ? (
                  <span className="mt-1 block">
                    <Badge tone="warning">{copy.threads.unread(thread.unread)}</Badge>
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

interface PhoneProps {
  readonly thread: SimThread;
  readonly firmName: string | undefined;
  readonly typing: boolean;
  readonly busy: boolean;
  readonly act: (action: SimulatorAction) => Promise<unknown>;
  readonly uploadOwn: (file: File) => Promise<unknown>;
}

export function Phone({ thread, firmName, typing, busy, act, uploadOwn }: PhoneProps) {
  const groups = byDay(phoneMessages(thread));
  const tap = (message: SimMessage, button: SimButton) => void act({ kind: "tapButton", input: { importerId: thread.importerId, messageId: message.messageId, action: button.action } });
  return (
    <section aria-label={copy.phone.title(thread.importerName)} className="mx-auto w-full max-w-md overflow-hidden rounded-3xl border-8 border-navy-deep bg-mist shadow-card">
      <header className="bg-navy px-4 py-3 text-white">
        <p className="text-xs font-semibold tracking-wide text-cyan-soft uppercase">{copy.frameLabel}</p>
        <p className="mt-1 font-semibold">{firmName ?? copy.phone.chatWith}</p>
        <p className="text-xs text-cyan-soft">
          {thread.contactName} · <span className="font-mono">{thread.phoneMasked}</span>
        </p>
      </header>
      <div className="flex h-128 flex-col gap-3 overflow-y-auto px-3 py-4" aria-live="polite">
        {groups.length === 0 ? <p className="text-center text-sm text-slate">{copy.phone.empty}</p> : null}
        {groups.map((group) => (
          <div key={group.day} className="flex flex-col gap-2">
            <p className="mx-auto rounded-full bg-white px-3 py-0.5 text-xs text-slate shadow-card">{group.day}</p>
            <ul className="flex flex-col gap-2">
              {group.messages.map((message) => (
                <Bubble key={message.messageId} message={message} onTap={tap} tapping={busy} />
              ))}
            </ul>
          </div>
        ))}
        {typing ? (
          <p role="status" className="self-start rounded-lg bg-white px-3 py-2 text-sm text-slate italic shadow-card">
            {copy.phone.typing}
          </p>
        ) : null}
      </div>
      {thread.unread > 0 ? (
        <div className="flex justify-end bg-paper px-3 pt-2">
          <Button variant="ghost" disabled={busy} onClick={() => void act({ kind: "markRead", input: { importerId: thread.importerId } })}>
            {copy.phone.markRead}
          </Button>
        </div>
      ) : null}
      <Composer thread={thread} busy={busy} act={act} uploadOwn={uploadOwn} />
    </section>
  );
}
