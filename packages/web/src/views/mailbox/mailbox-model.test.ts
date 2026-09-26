import { describe, expect, it } from "vitest";
import { ALL_MAILBOXES, type MailboxList, displayAddress, mailRows, mailboxLabel, selectedMail, threadOf } from "./mailbox-model";

const FIRM_BOX = "estudio-delta@sim.legajo.demo.craftech.io";
const SUPPLIER_BOX = "supplier-qingdao@sim.legajo.demo.craftech.io";
const THREAD = "op-4471-k7p2q9@legajo.demo.craftech.io";

const LIST: MailboxList = {
  clockId: "GLOBAL#firm-delta",
  mailboxes: [
    {
      address: FIRM_BOX,
      owner: "FIRM",
      messages: [{ mailboxAddress: FIRM_BOX, mailboxMessageId: "m-esc", from: "avisos@legajo.demo.craftech.io", to: FIRM_BOX, subject: "Escalamiento 4478", receivedAtReal: "2026-09-26T15:10:00.000Z", receivedAtSim: "2026-10-26T08:00:00-03:00", operationId: "op-4478" }],
    },
    {
      address: SUPPLIER_BOX,
      owner: "SUPPLIER",
      supplierId: "sup-qingdao",
      messages: [
        { mailboxAddress: SUPPLIER_BOX, mailboxMessageId: "m-req", from: THREAD, to: SUPPLIER_BOX, subject: "Operation 4471: missing documents", receivedAtReal: "2026-09-26T15:00:00.000Z", receivedAtSim: "2026-10-15T22:00:00-03:00", operationId: "op-4471" },
        { mailboxAddress: SUPPLIER_BOX, mailboxMessageId: "m-corr", from: THREAD, to: SUPPLIER_BOX, subject: "Operation 4471: correction", receivedAtReal: "2026-09-26T15:05:00.000Z", receivedAtSim: "2026-10-15T22:10:00-03:00", operationId: "op-4471" },
      ],
    },
  ],
} as MailboxList;

describe("the demo mailbox", () => {
  it("lists every mail of the world newest first, or the mails of one mailbox", () => {
    expect(mailRows(LIST).map((row) => row.mailboxMessageId)).toEqual(["m-esc", "m-corr", "m-req"]);
    expect(mailRows(LIST, SUPPLIER_BOX).map((row) => row.mailboxMessageId)).toEqual(["m-corr", "m-req"]);
    expect(mailRows(LIST, "nobody@sim.legajo.demo.craftech.io")).toEqual([]);
    expect(mailRows({ mailboxes: [] }, ALL_MAILBOXES)).toEqual([]);
  });

  it("names an operation's thread address by its operation, never with its tag", () => {
    expect(displayAddress(THREAD)).toBe("dirección de la operación 4471");
    expect(displayAddress(SUPPLIER_BOX)).toBe(SUPPLIER_BOX);
    expect(threadOf({ operationId: "op-4471" })).toBe("Operación 4471");
    expect(threadOf({})).toBeUndefined();
  });

  it("names the mailboxes: the firm's, and each supplier's by the registry's name", () => {
    const names = new Map([["sup-qingdao", "Qingdao Bluewave Textiles Co., Ltd."]]);
    expect(mailboxLabel({ owner: "FIRM" }, names)).toBe("Buzón del estudio");
    expect(mailboxLabel({ owner: "SUPPLIER", supplierId: "sup-qingdao" }, names)).toBe("Proveedor: Qingdao Bluewave Textiles Co., Ltd.");
    expect(mailboxLabel({ owner: "SUPPLIER", supplierId: "sup-other" }, names)).toBe("Proveedor");
  });

  it("keeps the chosen mail while it is listed, else opens the newest", () => {
    const rows = mailRows(LIST);
    expect(selectedMail(rows, `${SUPPLIER_BOX}#m-req`)?.mailboxMessageId).toBe("m-req");
    expect(selectedMail(rows, "gone")?.mailboxMessageId).toBe("m-esc");
    expect(selectedMail([], undefined)).toBeUndefined();
  });
});
