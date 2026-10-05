// Channel modes (ADR-0002, docs/architecture-integrations.md §4, docs/build-plan.md WP-02).
//
// Email always runs `live` (SES end to end, simulated suppliers are mailboxes we own). WhatsApp runs
// `simulated` (the phone simulator of the console feeds the same inbound normalizer as the SNS
// payload of End User Messaging Social) until the WhatsApp Business Account is connected
// (docs/pending.md P-01). Switching to `live` is this value plus the two WhatsApp secrets; nothing
// else changes.
//
// Exposed as a Linkable so every Lambda reads them with `Resource.ChannelModes.<channel>` (through
// `readLinked`), never from `process.env`. `npm run channels:check-modes` (CI) fails when `whatsapp`
// is "live" while P-01 is still open in docs/pending.md, so keep each value a plain string literal on
// its own line.

export type ChannelMode = "live" | "simulated";
export type ChannelName = "email" | "whatsapp";

export const channelModes = {
  email: "live",
  whatsapp: "live", // P-01 closed on 2026-10-05
} as const satisfies Record<ChannelName, ChannelMode>;

export const ChannelModes = new sst.Linkable("ChannelModes", {
  properties: channelModes,
});
