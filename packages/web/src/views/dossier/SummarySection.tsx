// Summary of the dossier: ETA and time to arrival on the world's simulated clock, the dossier's state,
// who has the conversation, the customs dispatch and the estimated risk with its assumptions labelled
// "supuesto"; the parties (fictitious, phones and emails masked by the BFF) and the operation's data;
// and the "con error de proceso" notice when one of its events went to the dead-letter queue.
import type { ReactNode } from "react";
import { Badge } from "../../components/Badge";
import { Callout } from "../../components/Callout";
import { Section } from "../../components/Section";
import { StatGrid, StatTile } from "../../components/StatTile";
import { formatDateTime, formatSimDateTime } from "../../lib/format";
import { dossierCopy } from "./copy";
import { outstandingOf } from "./dossier-model";
import {
  controlLabel,
  customsChannelLabel,
  dispatchLabel,
  docStatusLabel,
  docTypeLabel,
  dossierStatusLabel,
  dossierStatusTone,
  eventTypeLabel,
  partyLabel,
  riskLabel,
  riskTone,
} from "./labels";
import { type Risk, riskOf, timeToEta } from "./risk";
import type { DossierData } from "./types";

const facts = dossierCopy.facts;
const parties = dossierCopy.parties;
const riskText = dossierCopy.risk;

function Fictitious() {
  return <Badge>{parties.fictitious}</Badge>;
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

function Parties({ dossier }: { readonly dossier: DossierData }) {
  const { importer, supplier, operation } = dossier;
  return (
    <dl className="grid gap-4 md:grid-cols-2">
      <Fact label={parties.importer}>
        <span className="inline-flex flex-wrap items-center gap-2 font-semibold">
          {importer.name} <Fictitious />
        </span>
        <span className="block text-slate">{parties.contact(importer.contactName, importer.phoneMasked)}</span>
      </Fact>
      <Fact label={parties.supplier}>
        <span className="inline-flex flex-wrap items-center gap-2 font-semibold">
          {supplier.name} <Fictitious />
        </span>
        <span className="block text-slate">{parties.supplierZone(supplier.country, supplier.timezone)}</span>
        <span className="mt-1 block text-xs font-semibold uppercase tracking-wide text-slate">{parties.contacts}</span>
        {supplier.contacts.length === 0 ? (
          <span className="block text-slate">{parties.noContacts}</span>
        ) : (
          <ul>
            {supplier.contacts.map((contact) => (
              <li key={contact.contactId} className="text-slate">
                {contact.emailMasked} · {parties.contactStatus[contact.status] ?? ""}
              </li>
            ))}
          </ul>
        )}
      </Fact>
      <Fact label={parties.vessel}>
        <span className="inline-flex flex-wrap items-center gap-2">
          {operation.vessel} <Fictitious />
        </span>
        <span className="block text-slate">
          {parties.carrier}: {operation.carrier}
        </span>
      </Fact>
      <Fact label={parties.route}>{parties.routeValue(operation.portOfLoading, operation.portOfDischarge)}</Fact>
      <Fact label={parties.invoice}>{parties.invoiceValue(operation.invoiceNumber, operation.incoterm, operation.incotermPlace)}</Fact>
      <Fact label={parties.regime}>{operation.regime}</Fact>
    </dl>
  );
}

function RiskBlock({ dossier, risk }: { readonly dossier: DossierData; readonly risk: Risk | undefined }) {
  const outstanding = outstandingOf(dossier);
  return (
    <div className="space-y-2 rounded-md border border-mist px-4 py-3">
      <h3 className="text-sm font-semibold text-navy">{riskText.title}</h3>
      {risk ? <p className="text-sm text-ink">{riskText.level[risk]}</p> : null}
      {outstanding.length > 0 ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate">{riskText.outstanding}</p>
          <ul className="list-disc space-y-0.5 pl-5 text-sm text-ink">
            {outstanding.map((item) => (
              <li key={item.docType}>
                {docTypeLabel[item.docType]} ({docStatusLabel[item.status].toLowerCase()}) · {item.owedBy ? riskText.owedBy(partyLabel[item.owedBy].toLowerCase()) : riskText.nobody}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="text-xs text-slate">
        <Badge tone="warning">{riskText.assumptionLabel}</Badge> {riskText.assumption}
      </p>
    </div>
  );
}

interface SummarySectionProps {
  readonly dossier: DossierData;
  /** The world's simulated now; undefined until the clock answered. */
  readonly simNow: string | undefined;
}

export function SummarySection({ dossier, simNow }: SummarySectionProps) {
  const { operation, processError } = dossier;
  const risk = riskOf({ dossierStatus: operation.dossierStatus, documents: dossier.documents, eta: operation.eta }, simNow);
  const toEta = simNow === undefined ? undefined : timeToEta(operation.eta, simNow);
  const channel = operation.dispatch.channel;
  return (
    <Section id="summary" title={dossierCopy.sections.summary}>
      <div className="space-y-5">
        {processError ? <Callout tone="danger">{dossierCopy.processError(eventTypeLabel[processError.type], formatDateTime(processError.atReal))}</Callout> : null}
        <StatGrid>
          <StatTile label={facts.eta} value={<time dateTime={operation.eta}>{formatSimDateTime(operation.eta)}</time>} />
          <StatTile label={facts.toArrival} value={toEta === undefined ? facts.unknown : toEta.arrived ? facts.arrived : facts.toArrivalValue(toEta.days, toEta.hours)} />
          <StatTile label={facts.dossier} value={<Badge tone={dossierStatusTone[operation.dossierStatus]}>{dossierStatusLabel[operation.dossierStatus]}</Badge>} />
          <StatTile label={facts.control} value={<span className="text-base">{controlLabel[operation.control]}</span>} />
          <StatTile
            label={facts.dispatch}
            value={<span className="text-base">{channel ? `${dispatchLabel[operation.dispatch.status]} · ${customsChannelLabel[channel]}` : dispatchLabel[operation.dispatch.status]}</span>}
          />
          <StatTile label={facts.risk} value={risk ? <Badge tone={riskTone[risk]}>{riskLabel[risk]}</Badge> : facts.unknown} />
        </StatGrid>
        <RiskBlock dossier={dossier} risk={risk} />
        <Parties dossier={dossier} />
      </div>
    </Section>
  );
}
