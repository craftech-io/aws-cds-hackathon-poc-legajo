// Alt text and caption of every picture of the landing, in English (docs/landing-spec.md §7.3): the
// same captures as the Spanish page, since the console is in Spanish, explained in English.
import type { MEDIA_ES } from "./media-copy-es";

export const MEDIA_EN: typeof MEDIA_ES = {
  loading: "Loading captures…",
  unavailable: "The captures could not be loaded. The rest of the page works as usual.",
  items: {
    "console-operations": { alt: "Operations view with operation 4471 pinned at the top and its next event", caption: "Operations: every import with its ETA, file status and next event." },
    "console-simulator": { alt: "Phone simulator with the importer's WhatsApp thread for operation 4471", caption: "Phone simulator: the WhatsApp channel in simulated mode, with an English gloss." },
    "console-mailbox": { alt: "Demo mailbox with the English email thread between operation 4471 and the supplier", caption: "Demo mailbox: real emails through Amazon SES, in one thread." },
    "console-dossier-reading": { alt: "File detail for 4471 with the packing list reading that flags a gross weight difference and the supplier as owner", caption: "What the reader found and who must fix it." },
    "console-dossier": { alt: "File detail for 4471 with all three documents valid and the timeline", caption: "The complete file, with every step and its reason." },
    "console-clock": { alt: "Paused demo clock with the milestones rescheduled after the ETA change", caption: "Your demo's clock: simulated time moves with a button." },
    "console-escalations": { alt: "Escalations view with the case from operation 4471 and its reason", caption: "What the agent handed to the firm, by reason." },
    "console-mailbox-firm": { alt: "Escalation email received by the firm with the file status and the attempts", caption: "The notice the broker receives, with the context." },
    "console-dossier-approval": { alt: "File 4471 approved by the broker, with the approval on the timeline", caption: "Approving is always a person's call." },
    "console-metrics": { alt: "Metrics with the N, source and label of every number", caption: "Metrics with N, source and label: measured, scripted agent or assumption." },
    "console-audit": { alt: "Decision log with the rule behind each one and zero violations", caption: "Every decision, with the rule that made it." },
    "console-tour": { alt: "Guest console with the guided tour panel open on the first step", caption: "Your first sign-in: the paused world and the guided tour." },
    "upload-page": { alt: "Document upload page for operation 4471 on a phone", caption: "Upload link: the importer sees the operation number and what is missing, nothing else." },
    "upload-done": { alt: "Upload confirmation on a phone", caption: 'After "Done": what arrived and what is still missing.' },
    "og-card": { alt: "Legajo listo: every import file complete before the vessel arrives", caption: "The cover of Legajo listo." },
    "hero-conversation": { alt: "WhatsApp simulator with the document request, the delegation to the supplier and the deferral notice", caption: "The WhatsApp channel, with the real template texts." },
    "tour-request": { alt: "WhatsApp simulator with the document request template and its four buttons", caption: "The first request to the importer, with the approved template." },
    "tour-delegate": { alt: "WhatsApp simulator with the delegation to the supplier and the email deferred by their hours", caption: "The delegation to the supplier and the hours rule that defers the email." },
    "tour-supplier": { alt: "English email thread between the address of operation 4471 and the supplier, with the PDFs attached", caption: "What the supplier receives and what they answer, in one thread." },
    "tour-reader": { alt: "Document reader result: valid certificate and a packing list with a gross weight difference", caption: "The reading of every PDF, through the reader's contract." },
    "tour-owner": { alt: "Correction request to the supplier and a notice telling the importer there is nothing for them to do", caption: "The fix goes to whoever must make it." },
    "tour-eta": { alt: "Milestone table before and after the ETA change and the new deadline notice to the importer", caption: "The milestones the code reschedules when the ETA moves." },
    "tour-escalation": { alt: "Out-of-scope question stopped by the guardrail, fixed answer to the importer and escalation notice to the firm", caption: "What is not the agent's call goes to the broker." },
    "tour-approval": { alt: "File approval control that turns into approved by a person and the notice to the importer", caption: "Approval, always by a person." },
  },
};
