// The firm's decisions on a document: dispense an observation with its reason (FL-043) and classify
// or discard a version the reader did not recognize (FL-044, ADR-0003: a person classifies, never
// the product). Both run their `dossier.*` procedure and read the dossier again.
import { DocType } from "@legajo/shared";
import { useState } from "react";
import { ApiErrorNotice } from "../../components/ApiErrorNotice";
import { Button } from "../../components/Button";
import { Drawer } from "../../components/Drawer";
import { SelectField } from "../../components/SelectField";
import { dossierCopy } from "./copy";
import { docTypeLabel, observationCodeLabel } from "./labels";
import { ReasonForm } from "./ReasonForm";
import type { ObservationData, VersionData } from "./types";
import { useDossierAction } from "./use-dossier-action";

interface WaiveDrawerProps {
  readonly operationId: string;
  readonly observation: ObservationData;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function WaiveDrawer({ operationId, observation, onClose, onDone }: WaiveDrawerProps) {
  const action = useDossierAction(onDone);
  const text = dossierCopy.waive;
  const submit = async (reason: string) => {
    if (await action.run({ type: "waive", operationId, observationId: observation.observationId, reason })) onClose();
  };
  return (
    <Drawer open title={text.title} onClose={onClose} closeLabel={dossierCopy.close}>
      <div className="space-y-4">
        <p className="text-sm font-semibold text-navy">{observationCodeLabel[observation.code]}</p>
        <p className="text-sm text-slate">{text.lead}</p>
        <ReasonForm
          label={text.reason}
          hint={text.reasonHint}
          submit={text.submit}
          working={text.working}
          running={action.state.status === "running"}
          error={action.state.status === "error" ? action.state.error : undefined}
          requiredText={dossierCopy.reasonRequired}
          onSubmit={(reason) => void submit(reason)}
        />
      </div>
    </Drawer>
  );
}

interface ClassifyDrawerProps {
  readonly operationId: string;
  readonly version: VersionData;
  readonly onClose: () => void;
  readonly onDone: () => void;
}

export function ClassifyDrawer({ operationId, version, onClose, onDone }: ClassifyDrawerProps) {
  const action = useDossierAction(onDone);
  const [docType, setDocType] = useState<DocType>(version.docType);
  const text = dossierCopy.classify;
  const running = action.state.status === "running";
  const decide = async (discard: boolean) => {
    const base = { operationId, docVersionId: version.docVersionId };
    const done = await action.run(discard ? { type: "discard", ...base } : { type: "classify", ...base, docType });
    if (done) onClose();
  };
  return (
    <Drawer open title={text.title} onClose={onClose} closeLabel={dossierCopy.close}>
      <div className="space-y-4">
        <p className="text-sm text-slate">{text.lead}</p>
        <SelectField<DocType>
          label={text.docType}
          value={docType}
          options={DocType.options.map((value) => ({ value, label: docTypeLabel[value] }))}
          onChange={setDocType}
        />
        {action.state.status === "error" ? <ApiErrorNotice error={action.state.error} /> : null}
        <div className="flex flex-wrap gap-2">
          <Button disabled={running} onClick={() => void decide(false)}>
            {running ? text.working : text.submit}
          </Button>
          <Button variant="secondary" disabled={running} onClick={() => void decide(true)}>
            {text.discard}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
