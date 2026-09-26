import { describe, expect, it } from "vitest";
import { MAX_HTML_CHARS, decodeEntities, htmlToText } from "./html-text";

describe("[FL-038] HTML bodies as the text a reader sees", () => {
  it("[FL-038] drops every kind of hidden node, with nesting and quotes that hold >", () => {
    const html = [
      "<p>Visible one.</p>",
      '<div style="display:none" title="a>b">hidden A <div>still hidden</div> hidden B</div>',
      '<span style="visibility: hidden !important">hidden C</span>',
      '<span style="opacity:0.0">hidden D</span>',
      '<div style="max-height: 0px; overflow: hidden">hidden E</div>',
      '<input type="hidden" value="x"><p aria-hidden="TRUE">hidden F</p>',
      '<div class="gmail_quote">hidden G</div>',
      "<p>Visible two.</p>",
    ].join("");
    expect(htmlToText(html)).toBe("Visible one.\n\nVisible two.");
  });

  it("[FL-038] skips raw-text elements even when they hold markup, and comments", () => {
    expect(htmlToText("<p>a</p><script>if (x < 1) document.write('</div><p>injected</p>')</script><!-- <p>hidden</p> --><p>b</p>")).toBe("a\n\nb");
    expect(htmlToText("<style>p{}</style><title>t</title><p>c</p>")).toBe("c");
  });

  it("[FL-038] fails closed: an unclosed hidden element or a tag it cannot read ends the text", () => {
    expect(htmlToText('<p>kept</p><div hidden><p>never closed')).toBe("kept");
    expect(htmlToText('<p>kept</p><div style="display:none" title="<">secret</div><p>after</p>')).toBe("kept");
    expect(htmlToText("<p>kept</p><script>never closed")).toBe("kept");
  });

  it("renders blocks, list items, cells and entities", () => {
    expect(htmlToText("<ul><li>one</li><li>two &amp; three</li></ul><table><tr><td>a</td><td>b</td></tr></table><p>x&nbsp;&#8364;&#x20AC;&euro;&unknown;</p>")).toBe(
      "- one\n- two & three\n\na b\n\nx €€€&unknown;",
    );
    expect(decodeEntities("&#0;&#xD800;&lt;")).toBe("<");
  });

  it("stays linear on hostile markup and ignores what lies past 512 KB", () => {
    const started = performance.now();
    htmlToText(`<p>ok</p>${'<a title="x"'.repeat(40_000)}`);
    htmlToText("<a ".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(htmlToText(`<p>${"a".repeat(MAX_HTML_CHARS)}</p><p>tail</p>`)).not.toContain("tail");
  });
});
