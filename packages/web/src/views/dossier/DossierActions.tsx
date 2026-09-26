// What the firm can do on the dossier from the top of the view (docs/design-brief.md §6, row 2):
// take the conversation from the agent and give it back (FL-067, FL-070), write to the importer while
// the firm has it (FL-068), and the human decisions of approving and reopening (ApprovalControls).
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { ApprovalControls } from "./ApprovalControls";
import { ComposerDrawer } from "./ComposerDrawer";
import { dossierCopy } from "./copy";
import { composerMode, whatsappWindowOpen } from "./dossier-model";
import type { DossierData, TimelineEntryData } from "./types";
import { useDossierAction } from "./use-dossier-action";

const text = dossierCopy.conversation;

interface DossierActionsProps {
  readonly dossier: DossierData;
  readonly entries: readonly TimelineEntryData[];
  /** The world's simulated now, for the 24-hour window of WhatsApp. */
  readonly simNow: string | undefined;
  readonly onChanged: () => void;
}

export function DossierActions({ dossier, entries, simNow, onChanged }: DossierActionsProps) {
  const control = useDossierAction(onChanged);
  const [composing, setComposing] = useState(false);
  const { operationId, control: owner, dossierStatus } = dossier.operation;
  const running = control.state.status === "running";
  const mode = composerMode(owner, dossierStatus, whatsappWindowOpen(entries, simNow));

  return (
    <section aria-label={dossierCopy.actions} className="mb-6 space-y-3 rounded-card border border-mist bg-white px-4 py-3 shadow-card">
      <div className="flex flex-wrap items-center gap-2">
        {owner === "AGENT" ? (
          <Button variant="secondary" disabled={running} onClick={() => void control.run({ type: "take", operationId })}>
            {running ? text.working : text.take}
          </Button>
        ) : (
          <>
            <Button variant="secondary" disabled={running} onClick={() => void control.run({ type: "release", operationId })}>
              {running ? text.working : text.release}
            </Button>
            <Button variant="secondary" onClick={() => setComposing(true)}>
              {text.write}
            </Button>
          </>
        )}
        <ApprovalControls dossier={dossier} onChanged={onChanged} />
      </div>
      {owner === "AGENT" ? <p className="text-xs text-slate">{text.takeHint}</p> : null}
      {control.state.status === "error" ? <ApiErrorNotice error={control.state.error} /> : null}
      {composing ? <ComposerDrawer operationId={operationId} mode={mode} onClose={() => setComposing(false)} onDone={onChanged} /> : null}
    </section>
  );
}
