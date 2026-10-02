// `npm run landing:renders` (ADR-0016 §4): every render of the landing, the capture that replaces it,
// what the manifest has for that capture today, its policy and the criterion to replace it; for the
// reports of `qa` and the plan. Read-only.
import { readFileSync } from "node:fs";
import { rendersReport, RendersFile } from "./check-rules";
import { RENDERS_PATH, readManifest } from "./manifest-file";

const rows = rendersReport(readManifest(), RendersFile.parse(JSON.parse(readFileSync(RENDERS_PATH, "utf8"))));
const header = ["id", "replacedBy", "capture", "policy", "until"] as const;
const table = [header.join(" | "), header.map(() => "---").join(" | "), ...rows.map((row) => header.map((key) => row[key]).join(" | "))];
process.stdout.write(`${table.join("\n")}\n`);
