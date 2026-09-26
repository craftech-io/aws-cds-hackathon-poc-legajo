// Simulador de teléfono (`/app/simulator`, docs/design-brief.md §6, FL-083): the phone of the firm's
// importers while WhatsApp runs in simulated mode. It opens the main story's thread (Norpampa,
// operation 4471 of the guided tour) unless the user picks another, highlights the threads with
// unread messages, shows templates, buttons, links and attachments as WhatsApp does with their English
// gloss behind "EN", and says "El agente está escribiendo…" while a turn runs. Writing, tapping,
// attaching and marking as read go through the BFF (`simulator.*`), which builds the same envelope as
// a real WhatsApp event; the threads follow the world at the shell's cadence.
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Callout } from "../../components/Callout";
import { PageHeader } from "../../components/PageHeader";
import { RemoteBlock } from "../../components/RemoteBlock";
import { useFirm } from "../../context/FirmContext";
import { useSession } from "../../context/SessionContext";
import { useLiveRemote, useWorldClock } from "../../context/WorldClockContext";
import { copy as consoleCopy } from "../../copy/console";
import { useAction } from "../../lib/use-remote";
import { simulatorCopy } from "./copy";
import { LiveModeNotice } from "./Composer";
import { Phone, ThreadList } from "./Phone";
import { LIVE_MODE_REASON, type SimulatorAction, type SimulatorThreads, fetchThreads, runSimulatorAction, uploadOwnPdf } from "./simulator-api";
import { defaultThread, isTyping } from "./simulator-model";

type Done = keyof typeof simulatorCopy.done;

const DONE_OF: Readonly<Record<SimulatorAction["kind"], Done>> = { sendText: "sent", tapButton: "tapped", attachDocument: "attached", markRead: "read" };

function Simulator({ data, onChanged }: { readonly data: SimulatorThreads; readonly onChanged: () => void }) {
  const { trpc } = useSession();
  const { snapshot } = useWorldClock();
  const { firmName } = useFirm();
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [done, setDone] = useState<Done>("sent");
  const action = useAction(async (request: SimulatorAction) => {
    await runSimulatorAction(trpc, request);
    setDone(DONE_OF[request.kind]);
    onChanged();
    return true;
  });
  const upload = useAction(async ({ importerId, file }: { importerId: string; file: File }) => {
    const key = await uploadOwnPdf(trpc, importerId, file);
    await runSimulatorAction(trpc, { kind: "attachDocument", input: { importerId, source: { kind: "UPLOAD", key } } });
    setDone("attached");
    onChanged();
    return true;
  });
  const thread = defaultThread(data.threads, chosen);
  const busy = action.state.status === "running" || upload.state.status === "running";
  const failure = action.state.status === "error" ? action.state.error : upload.state.status === "error" ? upload.state.error : undefined;
  const succeeded = action.state.status === "done" || upload.state.status === "done";

  return (
    <div className="grid gap-6 2xl:grid-cols-[18rem_minmax(0,1fr)]">
      <ThreadList threads={data.threads} current={thread?.importerId} onOpen={setChosen} />
      <div className="flex min-w-0 flex-col gap-3">
        {thread ? (
          <Phone
            thread={thread}
            firmName={firmName}
            typing={isTyping(thread, snapshot?.pending ?? [])}
            busy={busy}
            act={(request) => action.run(request)}
            uploadOwn={(file) => upload.run({ importerId: thread.importerId, file })}
          />
        ) : null}
        {failure ? <ApiErrorNotice error={failure} /> : succeeded ? <Callout tone="success" title={simulatorCopy.done[done]} /> : null}
      </div>
    </div>
  );
}

export default function View() {
  const { trpc } = useSession();
  const { refresh: refreshClock } = useWorldClock();
  const threads = useLiveRemote("simulator.threads", (signal) => fetchThreads(trpc, signal));
  const view = consoleCopy.views.simulator;
  const onChanged = () => {
    threads.refresh();
    // The world is busy now (an event in flight): ask the clock so the shell polls every 3 s.
    refreshClock();
  };
  const live = threads.state.status === "error" && threads.state.error.reason === LIVE_MODE_REASON;
  return (
    <div>
      <PageHeader title={view.title} description={view.description} />
      <p className="mb-4 max-w-3xl text-sm text-slate">{simulatorCopy.lead}</p>
      {live ? (
        <LiveModeNotice />
      ) : (
        <RemoteBlock state={threads.state} onRetry={threads.reload}>
          {(data) => <Simulator data={data} onChanged={onChanged} />}
        </RemoteBlock>
      )}
    </div>
  );
}
