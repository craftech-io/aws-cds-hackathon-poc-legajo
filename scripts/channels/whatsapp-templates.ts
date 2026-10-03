// Registers the eight `UTILITY` `es_AR` WhatsApp templates with Meta through End User Messaging Social
// (docs/architecture-integrations.md §4.3, docs/pending.md P-01 step 7). The texts have one source,
// packages/bff/src/copy/templates.ts. Runs inside `sst shell` once the WABA is connected (the `WabaId`
// secret is no longer `not-connected`); without `--apply` it only prints what it would do.
//
//   npm run channels:whatsapp-templates -- --stage poc            plan: which templates exist, which not
//   npm run channels:whatsapp-templates -- --stage poc --apply    creates the missing ones and records
//                                                                 `metaTemplateId` and `status` in
//                                                                 `Reference/TEMPLATE#WHATSAPP`
//
// SDK commands, checked in the installed `@aws-sdk/client-socialmessaging` `.d.ts` before use:
// `ListWhatsAppMessageTemplatesCommand {id, nextToken}` → `templates[{templateName, templateLanguage,
// metaTemplateId, templateStatus, templateCategory}]`, and `CreateWhatsAppMessageTemplateCommand
// {id, templateDefinition: Uint8Array}` → `{metaTemplateId, templateStatus, category}`. The definition
// is Meta's template JSON (name, language, category, components).
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateWhatsAppMessageTemplateCommand, ListWhatsAppMessageTemplatesCommand, SocialMessagingClient } from "@aws-sdk/client-socialmessaging";
import type { WhatsAppTemplateName } from "@legajo/shared";
import { REFERENCE_SCOPES, referenceKey } from "@legajo/bff/connector/keys";
import { TEMPLATES, UPLOAD_LINK_BASE_URL, type TemplateDefinition } from "@legajo/bff/copy/templates";
import { TemplateStatus } from "@legajo/bff/domain/reference";
import { awsClientConfig } from "@legajo/bff/lib/clients";
import { STAGE_REGION } from "@legajo/bff/public-web/presign";
import { parseFlags } from "./cli-args";

export const STAGE = "poc";
/** A sample upload token for Meta's review of the URL button (shape of a real one, never valid). */
const EXAMPLE_TOKEN = "Ab3dEf6hIj9lMn2pQr5tUv8xYz1bCd4fGh7jKl0nPq3";

export interface TemplatesArgs {
  stage?: string;
  apply?: boolean;
}

export function parseTemplatesArgs(argv: readonly string[]): TemplatesArgs {
  const args: TemplatesArgs = {};
  parseFlags(argv, { "--stage": (value) => void (args.stage = value()), "--apply": () => void (args.apply = true) });
  if (args.stage !== STAGE) throw new RangeError(`--stage ${STAGE} is required (the only stage)`);
  return args;
}

/** Meta's template JSON for one of our definitions. */
export function metaDefinition(template: TemplateDefinition): Record<string, unknown> {
  const components: Array<Record<string, unknown>> = [
    { type: "BODY", text: template.body, ...(template.params.length === 0 ? {} : { example: { body_text: [template.params.map((param) => param.example)] } }) },
  ];
  if (template.buttons.length > 0) {
    components.push({
      type: "BUTTONS",
      buttons: template.buttons.map((button) =>
        button.type === "URL" ? { type: "URL", text: button.text, url: button.url ?? `${UPLOAD_LINK_BASE_URL}{{1}}`, example: [`${UPLOAD_LINK_BASE_URL}${EXAMPLE_TOKEN}`] } : { type: "QUICK_REPLY", text: button.text },
      ),
    });
  }
  return { name: template.name, language: template.language, category: template.category, components };
}

export interface RemoteTemplate {
  readonly name: string;
  readonly language: string;
  readonly metaTemplateId?: string;
  readonly status?: string;
}

export interface TemplatesDeps {
  list(wabaId: string): Promise<RemoteTemplate[]>;
  create(wabaId: string, definition: Record<string, unknown>): Promise<{ readonly metaTemplateId?: string; readonly status?: string; readonly category?: string }>;
  record(name: WhatsAppTemplateName, update: { readonly metaTemplateId?: string; readonly status: TemplateStatus }): Promise<void>;
  wabaId(): string | undefined;
  report(line: string): void;
}

/** Meta's status as the `Reference` row stores it; anything unknown is still under review. */
export function statusOf(remote: string | undefined): TemplateStatus {
  const parsed = TemplateStatus.safeParse(remote?.toUpperCase());
  return parsed.success && parsed.data !== "LOCAL_ONLY" ? parsed.data : "PENDING";
}

export async function runTemplates(args: TemplatesArgs, deps: TemplatesDeps): Promise<{ readonly created: number; readonly existing: number }> {
  const wabaId = deps.wabaId();
  if (wabaId === undefined) throw new RangeError("the WABA is not connected (secret WabaId is not-connected): close docs/pending.md P-01 first");
  const remote = await deps.list(wabaId);
  let created = 0;
  let existing = 0;
  for (const template of Object.values(TEMPLATES)) {
    const found = remote.find((entry) => entry.name === template.name && entry.language === template.language);
    if (found !== undefined) {
      existing += 1;
      deps.report(`${template.name}: exists (${found.status ?? "unknown status"})`);
      if (args.apply) await deps.record(template.name, { ...(found.metaTemplateId === undefined ? {} : { metaTemplateId: found.metaTemplateId }), status: statusOf(found.status) });
      continue;
    }
    if (!args.apply) {
      deps.report(`${template.name}: would be created (run with --apply)`);
      continue;
    }
    const answer = await deps.create(wabaId, metaDefinition(template));
    if (answer.category !== undefined && answer.category !== template.category) deps.report(`${template.name}: Meta categorized it ${answer.category}; adjust copy/templates.ts and repeat`);
    await deps.record(template.name, { ...(answer.metaTemplateId === undefined ? {} : { metaTemplateId: answer.metaTemplateId }), status: statusOf(answer.status) });
    created += 1;
    deps.report(`${template.name}: created (${answer.status ?? "PENDING"})`);
  }
  return { created, existing };
}

const TIMEOUTS = { requestTimeoutMs: 10_000, connectionTimeoutMs: 2_000, maxAttempts: 4 };

async function stageDeps(): Promise<TemplatesDeps> {
  const { whatsAppConnection } = await import("@legajo/bff/lib/secrets");
  const { tableClient } = await import("@legajo/bff/connector/index");
  const client = new SocialMessagingClient({ region: STAGE_REGION, ...awsClientConfig(TIMEOUTS) });
  const table = tableClient();
  return {
    async list(id) {
      const templates: RemoteTemplate[] = [];
      let nextToken: string | undefined;
      do {
        const page = await client.send(new ListWhatsAppMessageTemplatesCommand({ id, nextToken }));
        for (const entry of page.templates ?? []) {
          templates.push({ name: entry.templateName ?? "", language: entry.templateLanguage ?? "", ...(entry.metaTemplateId === undefined ? {} : { metaTemplateId: entry.metaTemplateId }), ...(entry.templateStatus === undefined ? {} : { status: entry.templateStatus }) });
        }
        nextToken = page.nextToken;
      } while (nextToken);
      return templates;
    },
    async create(id, definition) {
      const answer = await client.send(new CreateWhatsAppMessageTemplateCommand({ id, templateDefinition: new TextEncoder().encode(JSON.stringify(definition)) }));
      return { ...(answer.metaTemplateId === undefined ? {} : { metaTemplateId: answer.metaTemplateId }), ...(answer.templateStatus === undefined ? {} : { status: answer.templateStatus }), ...(answer.category === undefined ? {} : { category: answer.category }) };
    },
    async record(name, update) {
      await table.update("Reference", referenceKey("TEMPLATE", REFERENCE_SCOPES.TEMPLATE, name), { set: { status: update.status, ...(update.metaTemplateId === undefined ? {} : { metaTemplateId: update.metaTemplateId }) } }, new Date().toISOString(), { condition: { ifExists: true } });
    },
    wabaId: () => whatsAppConnection()?.wabaId,
    report: (line) => process.stdout.write(`channels:whatsapp-templates: ${line}\n`),
  };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseTemplatesArgs(process.argv.slice(2));
  stageDeps()
    .then((deps) => runTemplates(args, deps))
    .catch((error: unknown) => {
      process.stderr.write(`channels:whatsapp-templates: ${error instanceof Error ? error.message : "failed"}\n`);
      process.exit(1);
    });
}
