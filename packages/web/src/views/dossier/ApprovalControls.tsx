// "Aprobar legajo" and "Reabrir legajo" (FL-073, FL-075, ADR-0010). Only a BROKER, or a GUEST in its own
// guest firm, sees them; an analyst never does, and the BFF refuses a direct call anyway. Approving is
// open once the dossier is ready for review. Both need a sign-in at most 15 minutes old: when it is
// older, the console asks for the password in the shell's own prompt without leaving the view, and
// opens the decision as soon as the prompt closes with a fresh sign-in.
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { usePrincipal, useSession } from "../../context/SessionContext";
import { ApproveDrawer, ReopenDrawer } from "./ApprovalDrawers";
import { dossierCopy } from "./copy";
import { approveGate, needsStepUp, reopenGate } from "./dossier-model";
import type { DossierData } from "./types";

type Decision = "approve" | "reopen";

interface ApprovalControlsProps {
  readonly dossier: DossierData;
  readonly onChanged: () => void;
}

export function ApprovalControls({ dossier, onChanged }: ApprovalControlsProps) {
  const principal = usePrincipal();
  const { prompt, openPrompt } = useSession();
  const status = dossier.operation.dossierStatus;
  const approve = approveGate(principal.role, status);
  const reopen = reopenGate(principal.role, status);
  const [open, setOpen] = useState<Decision | undefined>(undefined);
  const [afterStepUp, setAfterStepUp] = useState<Decision | undefined>(undefined);
  const [done, setDone] = useState<Decision | undefined>(undefined);
  const hintId = useId();

  // The password prompt closed: go on only if the sign-in is recent now (real time, as the BFF checks it).
  useEffect(() => {
    if (afterStepUp === undefined || prompt === "stepUp") return;
    if (!needsStepUp(principal.authTime, Date.now())) setOpen(afterStepUp);
    setAfterStepUp(undefined);
  }, [afterStepUp, prompt, principal.authTime]);

  const askPassword = useCallback(
    (decision: Decision) => {
      setOpen(undefined);
      setAfterStepUp(decision);
      openPrompt("stepUp");
    },
    [openPrompt],
  );

  const start = (decision: Decision) => {
    setDone(undefined);
    if (needsStepUp(principal.authTime, Date.now())) askPassword(decision);
    else setOpen(decision);
  };

  const finished = (decision: Decision) => () => {
    setDone(decision);
    onChanged();
  };

  return (
    <>
      {approve.visible ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!approve.enabled} {...(approve.enabled ? {} : { "aria-describedby": hintId })} onClick={() => start("approve")}>
            {dossierCopy.approval.approve}
          </Button>
          {approve.enabled ? null : (
            <span id={hintId} className="text-xs text-slate">
              {dossierCopy.approval.notReady}
            </span>
          )}
        </div>
      ) : null}
      {reopen.visible ? (
        <Button variant="secondary" onClick={() => start("reopen")}>
          {dossierCopy.reopen.open}
        </Button>
      ) : null}
      {done ? (
        <div className="w-full">
          <Callout tone="success">{done === "approve" ? dossierCopy.approval.done : dossierCopy.reopen.done}</Callout>
        </div>
      ) : null}
      {open === "approve" ? <ApproveDrawer dossier={dossier} onClose={() => setOpen(undefined)} onDone={finished("approve")} onStaleLogin={() => askPassword("approve")} /> : null}
      {open === "reopen" ? <ReopenDrawer dossier={dossier} onClose={() => setOpen(undefined)} onDone={finished("reopen")} onStaleLogin={() => askPassword("reopen")} /> : null}
    </>
  );
}
