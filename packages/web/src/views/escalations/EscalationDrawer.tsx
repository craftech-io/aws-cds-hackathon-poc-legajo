// One escalation opened from the inbox: its reason, summary and who opened it, and what the firm does
// with it (docs/design-brief.md §6, row 3): take the conversation of its operation (the agent pauses
// there and the dossier opens to write to the importer), look at the dossier, or resolve it with how
// it was solved, which the audit log keeps with the user and the simulated time.
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { Drawer } from "../../components/Drawer";
import { useSession } from "../../context/SessionContext";
import { useWorldClock } from "../../context/WorldClockContext";
import { formatSimDateTime } from "../../lib/format";
import { Link, useRouter } from "../../lib/router";
import { useAction } from "../../lib/use-remote";
import { dossierPath } from "../../routes";
import { runDossierAction } from "../dossier/api";
import { actorLabel, escalationReasonLabel } from "../dossier/labels";
import { ReasonForm } from "../dossier/ReasonForm";
import { resolveEscalation } from "./api";
import { escalationsCopy } from "./copy";
import type { EscalationRow } from "./escalations-model";

const text = escalationsCopy.drawer;

interface EscalationDrawerProps {
  readonly escalation: EscalationRow;
  readonly onClose: () => void;
  readonly onResolved: () => void;
}

export function EscalationDrawer({ escalation, onClose, onResolved }: EscalationDrawerProps) {
  const { trpc } = useSession();
  const { refresh } = useWorldClock();
  const { navigate } = useRouter();
  const [resolved, setResolved] = useState(false);
  const target = dossierPath(escalation.operationId);
  const take = useAction(async () => {
    await runDossierAction(trpc, { type: "take", operationId: escalation.operationId });
    refresh();
    return true;
  });
  const resolve = useAction(async (resolution: string) => {
    await resolveEscalation(trpc, { operationId: escalation.operationId, escalationId: escalation.escalationId, resolution });
    return true;
  });

  const onTake = async () => {
    if (await take.run(undefined)) navigate(target);
  };
  const onResolve = async (resolution: string) => {
    if (!(await resolve.run(resolution))) return;
    setResolved(true);
    onResolved();
  };

  return (
    <Drawer open title={text.operation(escalation.operationNumber)} onClose={onClose} closeLabel={text.close}>
      <div className="space-y-5 text-sm">
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">{text.reason}</p>
          <Badge tone="warning">{escalationReasonLabel[escalation.reason]}</Badge>
        </div>
        <div className="space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">{text.summary}</p>
          <p className="whitespace-pre-wrap text-ink">{escalation.summary || text.noSummary}</p>
          <p className="text-slate">{text.opened(formatSimDateTime(escalation.openedAtSim), actorLabel(escalation.openedBy))}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="secondary" busy={take.state.status === "running"} onClick={() => void onTake()}>
            {take.state.status === "running" ? text.taking : text.take}
          </Button>
          <Link to={target} className="text-sm font-semibold text-cyan-deep underline">
            {text.viewDossier}
          </Link>
        </div>
        <p className="text-xs text-slate">{text.takeLead}</p>
        {take.state.status === "error" ? <ApiErrorNotice error={take.state.error} /> : null}
        <div className="space-y-3 border-t border-mist pt-4">
          <h3 className="text-base font-semibold text-navy">{text.resolveTitle}</h3>
          {resolved ? (
            <Callout tone="success">{text.resolved}</Callout>
          ) : (
            <ReasonForm
              label={text.resolution}
              hint={text.resolutionHint}
              submit={text.resolve}
              working={text.resolving}
              running={resolve.state.status === "running"}
              error={resolve.state.status === "error" ? resolve.state.error : undefined}
              requiredText={text.resolutionRequired}
              onSubmit={(resolution) => void onResolve(resolution)}
            />
          )}
        </div>
      </div>
    </Drawer>
  );
}
