import { describe, expect, it } from "vitest";
import { ChannelError } from "@legajo/shared";
import { assertHeaderValue, formatMailbox, hasDomain, isReserved, namesOnly, parseAddress, parseMessageIds, parseReceivedAddress, sesMessageIdOf, sesRfcMessageId, singleAuthor } from "./address";

const ok = (raw: string) => {
  const parsed = parseAddress(raw);
  if (!parsed.ok) throw new Error(`expected ${raw} to parse, got ${parsed.problem}`);
  return parsed.value;
};
const problem = (raw: string) => {
  const parsed = parseAddress(raw);
  return parsed.ok ? "OK" : parsed.problem;
};

describe("[FL-059] strict address parser", () => {
  it("[FL-059] accepts the addresses of the stage exactly as the registry stores them", () => {
    expect(ok("supplier-qingdao@sim.legajo.demo.craftech.io")).toEqual({ address: "supplier-qingdao@sim.legajo.demo.craftech.io", local: "supplier-qingdao", domain: "sim.legajo.demo.craftech.io" });
    expect(ok("bounce+812-1-sc05-a@simulator.amazonses.com").local).toBe("bounce+812-1-sc05-a");
    expect(ok("op-4471-k7p2q9@legajo.demo.craftech.io").domain).toBe("legajo.demo.craftech.io");
  });

  it("[FL-059] refuses upper case, a trailing dot, quotes, display names, IDN, non-ASCII, two @ and CR/LF", () => {
    expect(problem("X@SIM.legajo.demo.craftech.io")).toBe("UPPER_CASE");
    expect(problem("x@sim.legajo.demo.craftech.io.")).toBe("TRAILING_DOT");
    expect(problem('"x y"@sim.legajo.demo.craftech.io')).toBe("WHITESPACE");
    expect(problem('"xy"@sim.legajo.demo.craftech.io')).toBe("SPECIAL_CHARACTERS");
    expect(problem("Name <x@sim.legajo.demo.craftech.io>")).toBe("WHITESPACE");
    expect(problem("<x@sim.legajo.demo.craftech.io>")).toBe("SPECIAL_CHARACTERS");
    expect(problem("x@xn--prvedor-9za.sim.legajo.demo.craftech.io")).toBe("IDN");
    expect(problem("x@provéedor.com")).toBe("NON_ASCII");
    expect(problem("x@y@sim.legajo.demo.craftech.io")).toBe("AT_COUNT");
    expect(problem("x@sim.legajo.demo.craftech.io\r\nBcc: a@b.co")).toBe("CONTROL_CHARACTERS");
    expect(problem("x@sim.legajo.demo.craftech.io\n")).toBe("CONTROL_CHARACTERS");
    expect(problem("")).toBe("EMPTY");
  });

  it("refuses malformed local parts and domains", () => {
    expect(problem(".x@sim.legajo.demo.craftech.io")).toBe("LOCAL_PART");
    expect(problem("x..y@sim.legajo.demo.craftech.io")).toBe("LOCAL_PART");
    expect(problem("x!@sim.legajo.demo.craftech.io")).toBe("LOCAL_PART");
    expect(problem("x@localhost")).toBe("DOMAIN");
    expect(problem("x@-bad.example.org")).toBe("DOMAIN");
    expect(problem("x@sim.legajo.demo.craftech.123")).toBe("DOMAIN");
    expect(problem(`${"a".repeat(65)}@sim.legajo.demo.craftech.io`)).toBe("LOCAL_PART");
    expect(problem(`x@${"a".repeat(250)}.io`)).toBe("TOO_LONG");
  });

  it("[FL-059] compares domains exactly: a look-alike suffix never matches", () => {
    const spoof = ok("x@sim.legajo.demo.craftech.io.attacker.example");
    expect(hasDomain(spoof, "sim.legajo.demo.craftech.io")).toBe(false);
    expect(isReserved(spoof)).toBe(true);
    expect(hasDomain(ok("x@sim.legajo.demo.craftech.io"), "sim.legajo.demo.craftech.io")).toBe(true);
  });

  it("[FL-059] flags every reserved domain of RFC 2606 and RFC 6761", () => {
    for (const address of ["x@proveedor.test", "x@example.com", "x@example.net", "x@example.org", "x@algo.example", "x@algo.invalid", "x@algo.localhost"]) {
      expect(isReserved(ok(address)), address).toBe(true);
    }
    expect(isReserved(ok("x@sim.legajo.demo.craftech.io"))).toBe(false);
  });

  it("normalizes a received From to lower case before parsing it strictly", () => {
    const parsed = parseReceivedAddress("  Supplier-Qingdao@SIM.legajo.demo.craftech.io ");
    expect(parsed).toEqual({ ok: true, value: { address: "supplier-qingdao@sim.legajo.demo.craftech.io", local: "supplier-qingdao", domain: "sim.legajo.demo.craftech.io" } });
    expect(parseReceivedAddress("Name <x@y.co>").ok).toBe(false);
  });
});

describe("header values", () => {
  it("refuses CR, LF and other control characters in any value built from data", () => {
    expect(assertHeaderValue("Subject", "[Op 4471] Missing documents")).toBe("[Op 4471] Missing documents");
    expect(() => assertHeaderValue("Subject", "hi\r\nBcc: x@y.co")).toThrow(ChannelError);
    expect(() => assertHeaderValue("Subject", "tab\tinside")).toThrow(ChannelError);
    expect(() => assertHeaderValue("Subject", "line\u2028separator")).toThrow(ChannelError);
    expect(() => assertHeaderValue("Subject", "   ")).toThrow(ChannelError);
    expect(() => assertHeaderValue("Subject", "x".repeat(901))).toThrow(ChannelError);
    expect(() => assertHeaderValue("Bad:Name", "x")).toThrow(ChannelError);
  });

  it("quotes an ASCII display name and encodes any other per RFC 2047", () => {
    const address = ok("op-4471-k7p2q9@legajo.demo.craftech.io");
    expect(formatMailbox("Estudio Delta via Legajo listo", address)).toBe('"Estudio Delta via Legajo listo" <op-4471-k7p2q9@legajo.demo.craftech.io>');
    expect(formatMailbox('Say "hi" \\ bye', address)).toBe('"Say \\"hi\\" \\\\ bye" <op-4471-k7p2q9@legajo.demo.craftech.io>');
    const encoded = formatMailbox("Estudio Delta · despachos via Legajo listo", address);
    expect(encoded).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=(?: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=)* <op-4471-k7p2q9@legajo\.demo\.craftech\.io>$/);
    const decoded = [...encoded.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((match) => Buffer.from(match[1] ?? "", "base64").toString("utf8")).join("");
    expect(decoded).toBe("Estudio Delta · despachos via Legajo listo");
    expect(() => formatMailbox("Estudio\r\nBcc: x", address)).toThrow(ChannelError);
  });
});

describe("message ids", () => {
  it("reads every <id@domain> of a header once, in order", () => {
    expect(parseMessageIds("<a@x.co> <b@y.co>\r\n <a@x.co>")).toEqual(["<a@x.co>", "<b@y.co>"]);
    expect(parseMessageIds(undefined)).toEqual([]);
    expect(parseMessageIds("no ids here")).toEqual([]);
  });

  it("recognizes only the Message-ID SES gave a mail we sent", () => {
    const rfc = sesRfcMessageId("0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000");
    expect(rfc).toBe("<0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000@email.amazonses.com>");
    expect(sesMessageIdOf(rfc)).toBe("0100019a2b3c4d5e-6f708192-a3b4-45c6-97d8-e9fa0b1c2d3e-000000");
    expect(sesMessageIdOf("<abc@email.amazonses.com.attacker.example>")).toBeUndefined();
    expect(sesMessageIdOf("<reply-1@sim.legajo.demo.craftech.io>")).toBeUndefined();
  });
});

describe("[FL-036] the one author of a received mail", () => {
  const CONTACT = "supplier-qingdao@sim.legajo.demo.craftech.io";
  const NAMED = `"Qingdao Bluewave Textiles Co., Ltd." <${CONTACT}>`;

  it("[FL-036] reads one From with one mailbox, bare, quoted, unquoted or encoded, lower-cased", () => {
    expect(singleAuthor([CONTACT])).toBe(CONTACT);
    expect(singleAuthor([NAMED])).toBe(CONTACT);
    expect(singleAuthor([`Qingdao Bluewave <${CONTACT.toUpperCase()}>`])).toBe(CONTACT);
    expect(singleAuthor([`=?UTF-8?B?UWluZ2Rhbw==?= <${CONTACT}>`])).toBe(CONTACT);
    expect(singleAuthor([`"${CONTACT}" <${CONTACT}>`])).toBe(CONTACT);
  });

  it("[FL-036] refuses two From headers, two mailboxes, a group or a second address hidden without a comma", () => {
    const attacker = "<me@mail.attacker.example.net>";
    expect(singleAuthor([])).toBeUndefined();
    expect(singleAuthor([NAMED, attacker])).toBeUndefined();
    expect(singleAuthor([attacker, NAMED])).toBeUndefined();
    expect(singleAuthor([`${NAMED}, ${attacker}`])).toBeUndefined();
    expect(singleAuthor([`${attacker}, ${NAMED}`])).toBeUndefined();
    expect(singleAuthor([`Suppliers: ${CONTACT};`])).toBeUndefined();
    expect(singleAuthor([`<${CONTACT}> ${attacker}`])).toBeUndefined();
    expect(singleAuthor([`${CONTACT} me@mail.attacker.example.net`])).toBeUndefined();
    expect(singleAuthor([`Qingdao, Ltd. <${CONTACT}>`])).toBeUndefined();
    expect(singleAuthor(["undisclosed-recipients:;"])).toBeUndefined();
  });

  it("[FL-036] SES's commonHeaders.from has to name that author alone", () => {
    expect(namesOnly([NAMED], CONTACT)).toBe(true);
    expect(namesOnly(["Qingdao Bluewave Textiles Co., Ltd. <SUPPLIER-QINGDAO@sim.legajo.demo.craftech.io>"], CONTACT)).toBe(true);
    expect(namesOnly([NAMED, "<me@mail.attacker.example.net>"], CONTACT)).toBe(false);
    expect(namesOnly([`${NAMED}, <me@mail.attacker.example.net>`], CONTACT)).toBe(false);
    expect(namesOnly(["<me@mail.attacker.example.net>"], CONTACT)).toBe(false);
    expect(namesOnly([], CONTACT)).toBe(false);
  });
});
