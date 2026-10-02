// Shared secrets of the app (docs/architecture.md §3). Declared ONCE here; every other infra
// module imports the constant and puts it in the `link: [...]` of the Functions that need it.
// Declaring the same `sst.Secret` name in two modules is a duplicate-component error, so nobody
// writes `new sst.Secret(...)` anywhere else.
//
// | Secret                | What it is                                                           |
// |-----------------------|----------------------------------------------------------------------|
// | SessionTokenKey       | Master key. Never used directly: packages/bff/src/lib/crypto.ts      |
// |                       | derives one HKDF-SHA256 subkey per purpose (session, phone-hash,     |
// |                       | email-hash, nonce, sim-envelope, thread, runtime-session,            |
// |                       | signup-ticket, signup-seal, lead-email, rate, form).                 |
// | WabaId                | WhatsApp Business Account id of End User Messaging Social.           |
// |                       | `not-connected` until docs/pending.md P-01 is closed.                |
// | WhatsAppPhoneNumberId | `originationPhoneNumberId` of SendWhatsAppMessage. `not-connected`   |
// |                       | until P-01.                                                          |
// | SeedOverrides         | JSON of registered demo recipients (team mailboxes for the firm's    |
// |                       | demo mailbox, test phones for live WhatsApp). `{}` by default.       |
// | OriginVerifyKey       | Value of the `X-Origin-Verify` header the Router adds on `/api/*`    |
// |                       | and `/u/*` (infra/web.ts); Bff and PublicWeb compare it in constant  |
// |                       | time as the first step of every route, behind OAC (ADR-0015 §3.1).   |
// | LeadNoticeTo          | Up to 3 `<local>@craftech.io` mailboxes, comma separated, that get   |
// |                       | the notice of every new lead (LeadNotice, ADR-0015 §6). `disabled`   |
// |                       | turns the notice off. No address is ever written in the code.        |
//
// How they are read: packages/bff/src/lib/secrets.ts (`secretValue(name)`), through the SST link,
// never `process.env` and never the `environment` of a Function. infra/secrets.test.ts fails when
// the names declared here and `SECRET_NAMES` over there drift apart.
//
// How they are loaded. Values are set by the operator for `poc` before the first CI deploy
// (docs/architecture.md §15 step 3); no value is ever pasted in a chat, a commit, an `.env` file or
// a CI variable. An `sst.Secret` without a value aborts the deploy, so none has a default here: a
// well-known key must fail the deploy, not ship.
//
//   npx sst secret set SessionTokenKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set WabaId not-connected --stage poc
//   npx sst secret set WhatsAppPhoneNumberId not-connected --stage poc
//   npx sst secret set SeedOverrides '{}' --stage poc
//   npx sst secret set OriginVerifyKey "$(openssl rand -base64 32)" --stage poc
//   npx sst secret set LeadNoticeTo disabled --stage poc   # then the @craftech.io mailbox the CTO decides
//   npx sst secret list --stage poc      # prints values: never share the output
//
// - `SessionTokenKey` is never rotated casually: every phone and email hash, thread tag and
//   runtime session id derives from it, so a new key means a seed reload.
// - `SeedOverrides` and `LeadNoticeTo` hold real addresses of the team: PII, never logged.
// - `OriginVerifyKey` also lives in the code of the Router's viewer-request function (infra/web.ts),
//   readable inside the account with cloudfront:DescribeFunction (residual risk of docs/architecture.md
//   §13); rotating it is `sst secret set` plus a deploy.
// - After `sst secret set` the value reaches the Lambdas on the next deploy.

export const SessionTokenKey = new sst.Secret("SessionTokenKey");
export const WabaId = new sst.Secret("WabaId");
export const WhatsAppPhoneNumberId = new sst.Secret("WhatsAppPhoneNumberId");
export const SeedOverrides = new sst.Secret("SeedOverrides");
export const OriginVerifyKey = new sst.Secret("OriginVerifyKey");
export const LeadNoticeTo = new sst.Secret("LeadNoticeTo");
