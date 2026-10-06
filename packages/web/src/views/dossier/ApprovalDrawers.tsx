// The two human decisions on a dossier (ADR-0010): approve it after reviewing its documents and how
// each observation was resolved (FL-073), and reopen an approved one with its reason. Both run under
// the BFF's `recentLoginProcedure`: when it answers that the sign-in is too old, the drawer hands back
// to the caller, which asks for the password in place and comes back here.
import { useEffect } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Drawer } from "../../components/Drawer";
import { dossierCopy } from "./copy";
import { DocStatusBadge } from "./doc-status";
import { documentCards } from "./dossier-model";
import { docTypeLabel, observationCodeLabel, observationStatusLabel, observationStatusTone } from "./labels";
import { ReasonForm } from "./ReasonForm";
import type { DossierData } from "./types";
import { useDossierAction } from "./use-dossier-action";

interface DecisionDrawerProps {
  readonly dossier: DossierData;
  readonly onClose: () => void;
  readonly onDone: () => void;
  /** The BFF refused: the sign-in is older than 15 minutes. */
  readonly onStaleLogin: () => void;
}

function useStaleLogin(error: { readonly kind: string } | undefined, onStaleLogin: () => void): void {
  useEffect(() => {
    if (error?.kind === "recentLogin") onStaleLogin();
  }, [error, onStaleLogin]);
}

function Review({ dossier }: { readonly dossier: DossierData }) {
  const text = dossierCopy.approval;
  const cards = documentCards(dossier);
  const observations = cards.flatMap((card) => card.observations);
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate">{text.documents}</h3>
        <ul className="mt-2 space-y-1 text-sm">
          {cards.map((card) => (
            <li key={card.docType} className="flex items-center justify-between gap-3">
              <span>{docTypeLabel[card.docType]}</span>
              <DocStatusBadge status={card.status} />
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate">{text.observations}</h3>
        {observations.length === 0 ? (
          <p className="mt-2 text-sm text-slate">{text.noObservations}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {observations.map((observation) => (
              <li key={observation.observationId} className="space-y-0.5">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{observationCodeLabel[observation.code]}</span>
                  <Badge tone={observationStatusTone[observation.status]}>{observationStatusLabel[observation.status]}</Badge>
                </p>
                <p className="text-xs text-slate">
                  {docTypeLabel[observation.docType]} · {dossierCopy.documents.attempts(observation.attempts)}
                  {observation.waiveReason ? ` · ${dossierCopy.documents.waivedBecause(observation.waiveReason)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ApproveDrawer({ dossier, onClose, onDone, onStaleLogin }: DecisionDrawerProps) {
  const action = useDossierAction(onDone);
  const text = dossierCopy.approval;
  const error = action.state.status === "error" ? action.state.error : undefined;
  useStaleLogin(error, onStaleLogin);
  const approve = async () => {
    if (await action.run({ type: "approve", operationId: dossier.operation.operationId })) onClose();
  };
  return (
    <Drawer open title={text.title} onClose={onClose} closeLabel={dossierCopy.close}>
      <div className="space-y-5">
        <p className="text-sm text-slate">{text.lead}</p>
        <Review dossier={dossier} />
        {error && error.kind !== "recentLogin" ? <ApiErrorNotice error={error} /> : null}
        <Button busy={action.state.status === "running"} onClick={() => void approve()}>
          {action.state.status === "running" ? text.working : text.submit}
        </Button>
      </div>
    </Drawer>
  );
}

export function ReopenDrawer({ dossier, onClose, onDone, onStaleLogin }: DecisionDrawerProps) {
  const action = useDossierAction(onDone);
  const text = dossierCopy.reopen;
  const error = action.state.status === "error" ? action.state.error : undefined;
  useStaleLogin(error, onStaleLogin);
  const reopen = async (reason: string) => {
    if (await action.run({ type: "reopen", operationId: dossier.operation.operationId, reason })) onClose();
  };
  return (
    <Drawer open title={text.title} onClose={onClose} closeLabel={dossierCopy.close}>
      <div className="space-y-4">
        <p className="text-sm text-slate">{text.lead}</p>
        <ReasonForm
          label={text.reason}
          hint={text.reasonHint}
          submit={text.submit}
          working={text.working}
          running={action.state.status === "running"}
          error={error && error.kind !== "recentLogin" ? error : undefined}
          requiredText={dossierCopy.reasonRequired}
          onSubmit={(reason) => void reopen(reason)}
        />
      </div>
    </Drawer>
  );
}
