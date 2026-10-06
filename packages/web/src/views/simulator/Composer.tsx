// The bottom of the simulated phone: write as the importer, or attach a PDF, either a synthetic one of
// one of the thread's operations (copied on the server from the seed) or one of the user's own
// (a presigned POST to `Media/sim/…`, checked here for type and size first). Every action enters the
// BFF through the same envelope a real WhatsApp event has.
import { DocType } from "@legajo/shared";
import { useId, useState } from "react";
import { Button } from "../../components/Button";
import { Callout } from "../../components/Callout";
import { FIELD_CLASS, LABEL_CLASS } from "../../components/form-classes";
import { SelectField } from "../../components/SelectField";
import { simulatorCopy } from "./copy";
import type { SimThread, SimulatorAction } from "./simulator-api";
import { pdfProblem } from "./simulator-model";

const copy = simulatorCopy;
// The label is a getter so the options follow the console's language after import.
const DOC_OPTIONS = DocType.options.map((value) => ({
  value,
  get label() {
    return copy.docTypes[value];
  },
}));

interface ComposerProps {
  readonly thread: SimThread;
  readonly busy: boolean;
  readonly act: (action: SimulatorAction) => Promise<unknown>;
  readonly uploadOwn: (file: File) => Promise<unknown>;
}

function AttachPanel({ thread, busy, act, uploadOwn }: ComposerProps) {
  const [operationId, setOperationId] = useState(thread.operations[0]?.operationId ?? "");
  const [docType, setDocType] = useState<DocType>("CERTIFICATE_OF_ORIGIN");
  const [file, setFile] = useState<File | undefined>(undefined);
  const fileId = useId();
  const problem = file === undefined ? undefined : pdfProblem(file);
  const operations = thread.operations.map((operation) => ({ value: operation.operationId, label: operation.operationNumber }));
  return (
    <section aria-label={copy.attach.title} className="flex flex-col gap-3 border-t border-mist bg-white p-3">
      <p className="text-sm font-semibold text-navy">{copy.attach.synthetic}</p>
      <div className="flex flex-wrap items-end gap-2">
        {operations.length > 0 ? <SelectField label={copy.attach.operation} value={operationId} options={operations} onChange={setOperationId} /> : null}
        <SelectField label={copy.attach.docType} value={docType} options={DOC_OPTIONS} onChange={setDocType} />
        <Button
          variant="secondary"
          disabled={busy || operationId === ""}
          onClick={() => void act({ kind: "attachDocument", input: { importerId: thread.importerId, source: { kind: "SYNTHETIC", operationId, docType } } })}
        >
          {copy.attach.sendSynthetic}
        </Button>
      </div>
      <label htmlFor={fileId} className={LABEL_CLASS}>
        {copy.attach.own}
        <input id={fileId} type="file" accept="application/pdf,.pdf" className={FIELD_CLASS} onChange={(event) => setFile(event.target.files?.[0])} />
      </label>
      {problem ? <p className="text-xs text-danger">{copy.attach[problem]}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" disabled={busy || file === undefined || problem !== undefined} onClick={() => file && void uploadOwn(file)}>
          {copy.attach.sendOwn}
        </Button>
        <span className="text-xs text-slate">{copy.attach.scanning}</span>
      </div>
    </section>
  );
}

export function Composer(props: ComposerProps) {
  const { thread, busy, act } = props;
  const [text, setText] = useState("");
  const [attaching, setAttaching] = useState(false);
  const inputId = useId();
  const send = async () => {
    const value = text.trim();
    if (value === "") return;
    const result = await act({ kind: "sendText", input: { importerId: thread.importerId, text: value } });
    if (result !== undefined) setText("");
  };
  return (
    <div>
      {attaching ? <AttachPanel {...props} /> : null}
      <form
        className="flex items-center gap-2 border-t border-mist bg-paper p-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Button variant="ghost" aria-pressed={attaching} onClick={() => setAttaching((value) => !value)}>
          {attaching ? copy.composer.closeAttach : copy.composer.attach}
        </Button>
        <label htmlFor={inputId} className="sr-only">
          {copy.composer.label}
        </label>
        <input id={inputId} className={`${FIELD_CLASS} min-w-0 flex-1`} value={text} placeholder={copy.composer.placeholder} autoComplete="off" onChange={(event) => setText(event.target.value)} />
        <Button type="submit" disabled={busy || text.trim() === ""}>
          {copy.composer.send}
        </Button>
      </form>
    </div>
  );
}

export function LiveModeNotice() {
  return <Callout tone="warning" title={copy.liveMode} />;
}
