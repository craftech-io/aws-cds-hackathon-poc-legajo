// FL-084 · buzón de demo (docs/flows-catalog.md), against the local UI server: the real
// `mailbox.list` over the in-memory world lists the simulated mailboxes of the user's firm and of its
// suppliers, never another firm's. A scripted answer then checks that a mail reads in plain text
// only (markup shown as characters, no element, no iframe), with its thread headers and the
// operation's address named by its operation. Nothing leaves the machine.
import { type Page, expect, test } from "@playwright/test";
import { mailboxCopy } from "../src/views/mailbox/copy.ts";
import { routeApi, shellApi } from "./support/api-route";
import { blockExternalRequests, expectAccessibleBasics, expectNoRawCodes, expectView } from "./support/assertions";
import { plantSession } from "./support/session";

let blocked: string[];

test.beforeEach(async ({ page }) => {
  blocked = await blockExternalRequests(page);
});

test.afterEach(() => {
  expect(blocked, "requests that tried to leave the machine").toEqual([]);
});

function mailboxFilter(page: Page) {
  return page.getByLabel(mailboxCopy.filter);
}

test.describe("[FL-084] buzón de demo", () => {
  test("[FL-084] a broker sees the mailboxes of the firm and of its suppliers, read only", async ({ page }) => {
    await plantSession(page, "broker");
    await page.goto("/app/mailbox");
    await expectView(page, "mailbox");
    await expect(mailboxFilter(page).locator("option")).toHaveText([mailboxCopy.all, mailboxCopy.firmMailbox, mailboxCopy.supplierMailbox("Qingdao Bluewave Textiles Co., Ltd.")]);
    await expect(page.getByText(mailboxCopy.list.empty)).toBeVisible();
    await expect(page.getByText(mailboxCopy.reader.none)).toBeVisible();
    await expect(page.locator("iframe")).toHaveCount(0);
    await expectAccessibleBasics(page);
    await expectNoRawCodes(page);
  });

  test("[FL-084] another firm sees only its own mailbox, never a supplier mailbox of Estudio Delta", async ({ page }) => {
    await plantSession(page, "otherFirm");
    await page.goto("/app/mailbox");
    await expectView(page, "mailbox");
    await expect(mailboxFilter(page).locator("option")).toHaveText([mailboxCopy.all, mailboxCopy.firmMailbox]);
    await expect(page.getByText("Qingdao", { exact: false })).toHaveCount(0);
  });
});

const SUPPLIER_BOX = "supplier-qingdao@sim.legajo.demo.craftech.io";
const HOSTILE = 'Please see the packing list attached.\n<img src="x" onerror="alert(1)"><b>not bold</b>\n<iframe src="https://example.invalid"></iframe>';

test.describe("a mail in plain text (scripted answers)", () => {
  test("opens a mail with its thread headers and shows markup as characters, never as elements", async ({ page }) => {
    const header = {
      mailboxAddress: SUPPLIER_BOX,
      mailboxMessageId: "m-1",
      from: "op-4471-k7p2q9@legajo.demo.craftech.io",
      to: SUPPLIER_BOX,
      subject: "Operation 4471: packing list correction",
      receivedAtReal: "2026-09-26T15:00:00.000Z",
      receivedAtSim: "2026-10-15T22:10:00-03:00",
      operationId: "op-4471",
    };
    const calls = await routeApi(
      page,
      shellApi({
        "mailbox.list": { data: { clockId: "GLOBAL#firm-delta", mailboxes: [{ address: SUPPLIER_BOX, owner: "SUPPLIER", supplierId: "sup-qingdao", messages: [header] }] } },
        "mailbox.get": { data: { ...header, bodyText: HOSTILE } },
        "registry.suppliers.list": { data: { clockId: "GLOBAL#firm-delta", suppliers: [] } },
      }),
    );
    await plantSession(page, "broker");
    await page.goto("/app/mailbox");

    const mail = page.getByRole("article", { name: mailboxCopy.reader.title });
    await expect(mail.getByRole("heading", { name: header.subject })).toBeVisible();
    await expect(mail).toContainText(mailboxCopy.threadAddress("4471"));
    await expect(mail).toContainText(mailboxCopy.reader.threadOf("4471"));
    const body = mail.getByRole("region", { name: mailboxCopy.reader.body });
    await expect(body).toContainText('<img src="x" onerror="alert(1)"><b>not bold</b>');
    await expect(body.locator("img, b, iframe")).toHaveCount(0);
    await expect(page.locator("iframe")).toHaveCount(0);
    expect(calls.find((call) => call.path === "mailbox.get")?.input).toEqual({ mailboxAddress: SUPPLIER_BOX, mailboxMessageId: "m-1" });
    await expectNoRawCodes(page);
  });
});
