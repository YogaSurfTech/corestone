import { expect, test } from "./fixtures";

// The standalone rich-text editor demo (TSK-14): /editor-demo.html with
// the editor package only.

test.beforeEach(async ({ page }) => {
  await page.goto("/editor-demo.html");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator("#empty").click();
});

const stored = async (page: import("@playwright/test").Page) => JSON.parse(await page.locator("#json").inputValue());

test("formatting is stored as runs, plain text stays a string", async ({ page }) => {
  const area = page.locator(".cs-area .ProseMirror");
  await area.click();
  await page.keyboard.type("plain ");
  await page.keyboard.press("Control+b");
  await page.keyboard.type("bold");
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second line");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([
    { text: [{ text: "plain " }, { text: "bold", bold: true }] },
    { text: "second line" },
  ]);
  // the JSON as the entry's file holds it: one line per paragraph
  expect(await page.locator("#json").inputValue()).toBe(
    '[\n  {"text": [{"text": "plain "}, {"text": "bold", "bold": true}]},\n  {"text": "second line"}\n]');
  await expect(page.locator("#plain")).toHaveText("plain bold\nsecond line");
});

test("toolbar: colour, font, size, list, alignment; unavailable buttons say why", async ({ page }) => {
  const area = page.locator(".cs-area .ProseMirror");
  await area.click();
  await page.keyboard.type("Housing");
  await page.keyboard.press("Control+a");
  // font colour from the palette
  await page.locator(".cs-tb .sp:has([data-cmd=fcolor]) .c").click();
  await page.locator('.cs-tb .pop.open .sw[aria-label="#1565c0"]').click();
  // font and size
  await page.locator(".cs-tb .fontsel + .c").click();
  await page.locator(".cs-tb .pop.open .f", { hasText: "Georgia" }).click();
  await page.locator(".cs-tb .sz").fill("14");
  await page.locator(".cs-tb .sz").press("Enter");
  await expect(page.locator(".cs-tb .fontsel")).toHaveText("Georgia");
  // centred, then a bulleted list
  await page.locator(".cs-tb .sp:has([data-cmd=al], [data-cmd=ac], [data-cmd=ar], [data-cmd=aj]) .c").click();
  await page.locator(".cs-tb .pop.open [data-cmd=ac]").click();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ align: "center",
    text: [{ text: "Housing", color: "#1565c0", font: "Georgia", size: 14 }] }]);

  await page.locator(".cs-tb .sp:has([data-cmd=ul], [data-cmd=ol], [data-cmd=indent], [data-cmd=outdent]) .c").click();
  await page.locator(".cs-tb .pop.open [data-cmd=ul]").click();
  await page.locator("#save").click();
  expect((await stored(page))[0]).toMatchObject({ list: "ul", align: "center" });

  // redo has nothing to redo: disabled, and the tooltip says why
  const redo = page.locator(".cs-tb [data-cmd=redo]");
  await expect(redo).toHaveAttribute("aria-disabled", "true");
  await redo.hover();
  await expect(page.locator(".cs-tip.on")).toContainText("Nothing to redo.");
});

test("saved values come back; old plain strings and JSON load into the editor", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("kept");
  await page.locator("#save").click();
  await page.reload();
  await expect(page.locator(".cs-area .ProseMirror")).toHaveText("kept");

  await page.locator("#json").fill(JSON.stringify("line one\nline two"));
  await page.locator("#load").click();
  await expect(page.locator(".cs-area .ProseMirror p")).toHaveCount(2);
  // unformatted text stays plain text, lines as in a plain text field
  expect(await stored(page)).toBe("line one\nline two");
});

test("pasted HTML keeps only what the editor supports", async ({ page }) => {
  const area = page.locator(".cs-area .ProseMirror");
  await area.click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/html", '<h1 style="color:rgb(198,40,40)">Title</h1><p><b>bold</b> <span style="font-family:Comic Sans MS;font-size:12pt">odd font</span> <script>x()</script><img src="x.png"></p>');
    document.querySelector(".cs-area .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.locator("#save").click();
  const v = await stored(page);
  // the heading became a paragraph and kept its colour
  expect(v[0]).toEqual({ text: [{ text: "Title", color: "#c62828" }] });
  // bold kept; the unknown font dropped, its size kept; script and image gone
  const runs = v[1].text as { text: string }[];
  expect(runs.find((r) => r.text === "bold")).toEqual({ text: "bold", bold: true });
  expect(runs.find((r) => r.text === "odd font")).toEqual({ text: "odd font", size: 12 });
  expect(runs.map((r) => r.text).join("")).toBe("bold odd font");
  expect(v).toHaveLength(2);
  await page.screenshot({ path: "test-results/editor-demo.png", fullPage: true });
});

test("list markers follow the alignment; nested numbered lists count across levels", async ({ page }) => {
  const value = [
    { list: "ol", text: "one" },
    { list: "ol", level: 2, text: "one.one" },
    { list: "ol", level: 2, text: "one.two" },
    { list: "ol", level: 3, text: "one.two.one" },
    { list: "ol", text: "two" },
    { list: "ul", align: "right", text: "right bullet" },
  ];
  await page.locator("#json").fill(JSON.stringify(value));
  await page.locator("#load").click();
  // the flat paragraphs are nested lists in the editor, and come back unchanged
  await expect(page.locator(".cs-area ol ol ol li")).toHaveText("one.two.one");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual(value);
  const marker = (text: string) => page.locator(".cs-area li > p", { hasText: new RegExp(`^${text.replace(/\./g, "\\.")}$`) })
    .evaluate((el) => getComputedStyle(el, "::before").content);
  // CSS reports counters() as the rule, so check the rendered numbers through the plain text and the rule itself
  expect(await marker("one.two.one")).toContain("counters(cs-item");
  await expect(page.locator("#plain")).toHaveText("1. one\n  1.1. one.one\n  1.2. one.two\n    1.2.1. one.two.one\n2. two\n• right bullet");
  // the bullet of the right-aligned item sits next to its text on the right, not at the left edge
  const right = page.locator(".cs-area li > p", { hasText: "right bullet" });
  const box = (await right.boundingBox())!;
  const textLeft = await right.evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return r.getClientRects()[0].left;
  });
  expect(textLeft).toBeGreaterThan(box.x + box.width / 2);
  expect(await marker("right bullet")).toBe('"•"');
  await page.locator(".cs-editor").screenshot({ path: "test-results/editor-lists.png" });
});

test("Enter keeps the alignment, in lists and paragraphs", async ({ page }) => {
  await page.locator("#json").fill(JSON.stringify([
    { list: "ul", align: "right", text: "first" },
    { align: "center", text: "middle" },
  ]));
  await page.locator("#load").click();
  // ProseMirror takes over the clicked position a moment after the click; End must come after that
  const atEnd = async (text: string) => {
    await page.locator(".cs-area p", { hasText: text }).click();
    await page.waitForTimeout(100);
    await page.keyboard.press("End");
    await page.waitForTimeout(100); // the same for the cursor that End moved
  };
  await atEnd("first");
  await page.keyboard.press("Enter");
  await page.keyboard.type("second");
  await atEnd("middle");
  await page.keyboard.press("Enter");
  await page.keyboard.type("below");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([
    { list: "ul", align: "right", text: "first" },
    { list: "ul", align: "right", text: "second" },
    { align: "center", text: "middle" },
    { align: "center", text: "below" },
  ]);
});

test("a line break within a paragraph is stored as \\n", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("first");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second");
  await page.locator("#save").click();
  // a line break is not a new paragraph, so the value is no longer plain text
  expect(await stored(page)).toEqual([{ text: "first\nsecond" }]);
  await page.locator("#load").click();
  await expect(page.locator(".cs-area p br")).toHaveCount(1);
});

test("read-only shows the text without the toolbar, and can be switched", async ({ page }) => {
  const ed = page.locator("#ed");
  await ed.evaluate((el) => el.setAttribute("readonly", ""));
  await expect(page.locator(".cs-tb")).toBeHidden();
  await expect(page.locator(".cs-area .ProseMirror")).toHaveAttribute("contenteditable", "false");
  await ed.evaluate((el) => el.removeAttribute("readonly"));
  await expect(page.locator(".cs-tb")).toBeVisible();
  await expect(page.locator(".cs-area .ProseMirror")).toHaveAttribute("contenteditable", "true");
});

test("setting the same value again keeps the cursor", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("abc");
  // a host re-rendering hands back the value it got from the change event
  await page.locator("#ed").evaluate((el) => { const e = el as HTMLElement & { value: unknown }; e.value = e.value; });
  await page.keyboard.type("d");
  await page.locator("#save").click();
  expect(await stored(page)).toBe("abcd"); // a reset editor would have put the cursor at the start
});

test("background colours are light markers of the font colours, swatch for swatch", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("marked");
  await page.keyboard.press("Control+a");
  const menu = async (cmd: string) => {
    await page.locator(`.cs-tb .sp:has([data-cmd=${cmd}]) .c`).click();
    return page.locator(".cs-tb .pop.open .sw:not(.empty)");
  };
  const inks = await (await menu("fcolor")).evaluateAll((s) => s.map((e) => e.getAttribute("aria-label")));
  await page.locator(".cs-tb .sp:has([data-cmd=fcolor]) .c").click(); // closes the menu again
  const marks = await menu("bcolor");
  const markers = await marks.evaluateAll((s) => s.map((e) => e.getAttribute("aria-label")));
  expect(inks.slice(0, 8)).toEqual(["#1f2328", "#c62828", "#e65100", "#f9a825", "#2e7d32", "#1565c0", "#6a1b9a", "#ffffff"]);
  expect(markers.slice(0, 8)).toEqual(["#e6e8eb", "#ffcdd2", "#ffe0b2", "#fff59d", "#c8e6c9", "#bbdefb", "#e1bee7", "#57606a"]);
  // no marker is an ink colour: text cannot be blacked out with the palette
  expect(markers.slice(0, 8).filter((m) => inks.slice(0, 8).includes(m))).toEqual([]);
  // the blue swatch in both menus: blue ink on a light blue marker
  await marks.nth(5).click();
  await (await menu("fcolor")).nth(5).click();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ text: "marked", color: "#1565c0", bg: "#bbdefb" }] }]);
});

test("links: Ctrl+K links the selection; the bubble edits and removes; bad addresses are refused", async ({ page }) => {
  const area = page.locator(".cs-area .ProseMirror");
  await area.click();
  await page.keyboard.type("see the spec here");
  // select "spec"
  await page.evaluate(() => {
    const t = document.querySelector(".cs-area .ProseMirror p")!.firstChild!;
    const r = document.createRange(); r.setStart(t, 8); r.setEnd(t, 12);
    const s = getSelection()!; s.removeAllRanges(); s.addRange(r);
  });
  await page.keyboard.press("Control+k");
  const pop = page.locator(".cs-linkpop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".pick")).toBeHidden(); // the demo has no items to link to
  await pop.locator(".addr").fill("javascript:alert(1)");
  await pop.locator(".addr").press("Enter");
  await expect(pop.locator(".msg")).toContainText("Enter a web address");
  await pop.locator(".addr").fill("www.example.org/spec");
  await pop.locator(".addr").press("Enter");
  await expect(pop).toBeHidden();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ text: "see the " }, { text: "spec", href: "https://www.example.org/spec" }, { text: " here" }] }]);

  // the cursor in the link shows the bubble; Edit changes the address
  await area.locator("a").click();
  const bubble = page.locator(".cs-linkbubble");
  await expect(bubble.locator(".tgt")).toHaveText("https://www.example.org/spec");
  await bubble.locator(".edit").click();
  await expect(pop.locator(".addr")).toHaveValue("https://www.example.org/spec");
  await pop.locator(".addr").fill("https://example.org/v2");
  await pop.locator(".apply").click();
  await page.locator("#save").click();
  expect((await stored(page))[0].text[1]).toEqual({ text: "spec", href: "https://example.org/v2" });
  // typing after the link is plain text
  await area.locator("a").click();
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await page.locator("#save").click();
  expect((await stored(page))[0].text[2]).toEqual({ text: " here!" });
  // Remove keeps the text (the cursor goes into the link by keyboard: a third click there would be a triple click)
  await area.focus(); // back from the Save button
  await page.keyboard.press("End");
  for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowLeft");
  await bubble.locator(".unlink").click();
  await page.locator("#save").click();
  expect(await stored(page)).toBe("see the spec here!");
});

test("links: a pasted address links the selection or is inserted as a link", async ({ page }) => {
  const paste = (text: string) => page.evaluate((t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    document.querySelector(".cs-area .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("docs ");
  await paste("https://example.org/docs");
  await page.keyboard.type(" and ");
  await page.keyboard.type("mail");
  for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
  await page.waitForTimeout(100); // the editor takes over a keyboard selection a moment later; a scripted paste is faster
  await paste("mailto:team@example.org");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [
    { text: "docs " }, { text: "https://example.org/docs", href: "https://example.org/docs" },
    { text: " and " }, { text: "mail", href: "mailto:team@example.org" },
  ] }]);
  // text that is not an address pastes as text
  await page.locator(".cs-area .ProseMirror").focus(); // back from the Save button
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  await paste(" no link");
  await page.locator("#save").click();
  expect((await stored(page))[0].text[4]).toEqual({ text: " no link" });
});

test("links: open on Ctrl+click while editing, on a click when read-only", async ({ page }) => {
  await page.evaluate(() => { (window as unknown as { opened: string[] }).opened = []; window.open = (u?: string | URL) => { (window as unknown as { opened: string[] }).opened.push(String(u)); return null; }; });
  await page.locator("#json").fill(JSON.stringify([{ text: [{ text: "go ", }, { text: "there", href: "https://example.org/" }] }]));
  await page.locator("#load").click();
  const a = page.locator(".cs-area a");
  await a.click();
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual([]);
  await a.click({ modifiers: ["Control"] });
  await page.locator("#ed").evaluate((el) => el.setAttribute("readonly", ""));
  await a.click();
  expect(await page.evaluate(() => (window as unknown as { opened: string[] }).opened)).toEqual(["https://example.org/", "https://example.org/"]);
  await expect(page.locator(".cs-linkbubble")).toBeHidden();
});

const insertMenu = async (page: import("@playwright/test").Page) => {
  await page.locator(".cs-tb .sp:has([data-cmd=formula]) .c").click();
  return page.locator(".cs-tb .pop.open");
};

test("tables: insert with the size grid, Tab through the cells, Tab in the last cell adds a row", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("Intro");
  await (await insertMenu(page)).locator("[data-cmd=table]").click();
  const grid = page.locator(".cs-tablegrid");
  await expect(grid).toBeVisible();
  await grid.locator('button[data-r="2"][data-c="3"]').hover();
  await expect(grid.locator(".size")).toHaveText("3 × 2");
  await grid.locator('button[data-r="2"][data-c="3"]').click();
  await expect(page.locator(".cs-area table tr")).toHaveCount(2);
  await expect(page.locator(".cs-area table th")).toHaveCount(3);
  for (const t of ["Name", "Value", "Unit", "Pressure", "16", "bar"]) {
    await page.keyboard.type(t);
    await page.keyboard.press("Tab");
  }
  await page.keyboard.type("Temp");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([
    { text: "Intro" },
    { header: true, table: [["Name", "Value", "Unit"], ["Pressure", "16", "bar"], ["Temp", "", ""]] },
  ]);
  // inside a table no table can be inserted
  await page.locator(".cs-area td", { hasText: "Temp" }).click();
  await insertMenu(page);
  await expect(page.locator(".cs-tb .pop.open [data-cmd=table]")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#plain")).toHaveText("Intro\nName | Value | Unit\nPressure | 16 | bar\nTemp |  | ");
});

test("tables: the table bar adds columns, merges cells and switches the header row", async ({ page }) => {
  await page.locator("#json").fill(JSON.stringify([{ header: true, table: [["A", "B"], ["1", "2"]] }]));
  await page.locator("#load").click();
  await page.locator(".cs-area td", { hasText: "1" }).click();
  const bar = page.locator(".cs-tablebar");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Split" })).toBeDisabled();
  await bar.getByRole("button", { name: "+ Column right" }).click();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ header: true, table: [["A", "", "B"], ["1", "", "2"]] }]);
  // select two cells across the row and merge them
  await page.locator(".cs-area .ProseMirror").focus();
  await page.locator(".cs-area td", { hasText: "1" }).click();
  await page.waitForTimeout(100);
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  await page.keyboard.press("Shift+ArrowRight"); // over the cell border: the two cells are selected
  await expect(page.locator(".cs-area .selectedCell")).toHaveCount(2);
  await bar.getByRole("button", { name: "Merge" }).click();
  await page.locator("#save").click();
  expect((await stored(page))[0].table[1]).toEqual([{ content: "1", colspan: 2 }, "2"]);
  // the header row off (back in the table: the bar shows while the text has the focus)
  await page.locator(".cs-area td", { hasText: "2" }).click();
  await expect(bar.getByRole("button", { name: "Header row" })).toHaveAttribute("aria-pressed", "true");
  await bar.getByRole("button", { name: "Header row" }).click();
  await page.locator("#save").click();
  expect((await stored(page))[0].header).toBeUndefined();
});

test("tables: stored widths, spans and cell content come back unchanged", async ({ page }) => {
  const value = [
    { text: "Before" },
    { header: true, widths: [200, null, 90], table: [
      ["Property", "Value", "Unit"],
      [{ content: [{ text: [{ text: "Material", bold: true }] }, { list: "ul", text: "stainless" }], rowspan: 2 }, "1.4404", ""],
      ["316L", [{ text: "alt", align: "right" }]],
      [{ content: "Note across", colspan: 3 }],
    ] },
    { text: "After" },
  ];
  await page.locator("#json").fill(JSON.stringify(value));
  await page.locator("#load").click();
  await expect(page.locator(".cs-area td[rowspan='2'] li")).toHaveText("stainless");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual(value);
  // a table at the very end: the empty line after it for the cursor is not stored
  await page.locator("#json").fill(JSON.stringify([{ table: [["only"]] }]));
  await page.locator("#load").click();
  await expect(page.locator(".cs-area .ProseMirror > p")).toHaveCount(2);
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ table: [["only"]] }]);
});

test("tables: dragging a column border sets the column width", async ({ page }) => {
  await page.locator("#json").fill(JSON.stringify([{ table: [["A", "B"], ["1", "2"]] }]));
  await page.locator("#load").click();
  const a = page.locator(".cs-area td", { hasText: "A" });
  const box = (await a.boundingBox())!;
  const x = box.x + box.width - 1, y = box.y + box.height / 2;
  await page.mouse.move(x - 10, y);
  await page.mouse.move(x, y);
  await expect(page.locator(".cs-area .column-resize-handle").first()).toBeVisible(); // drawn on each cell of the column
  await page.mouse.down();
  await page.mouse.move(x - 60, y, { steps: 5 });
  await page.mouse.up();
  await page.locator("#save").click();
  const t = (await stored(page))[0];
  expect(t.widths[1]).toBeNull();
  expect(Math.abs(t.widths[0] - (box.width - 60))).toBeLessThan(8);
});

test("tables: pasted tables keep what the editor supports; a table in a table becomes text", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/html", `<table border="1" style="background:yellow"><colgroup><col width="300"></colgroup>
      <tr><th style="color:rgb(198,40,40)">Name</th><th>Value</th></tr>
      <tr><td><b>Pressure</b></td><td bgcolor="red"><table><tr><td>inner a</td><td>inner b</td></tr><tr><td>c</td><td>d</td></tr></table></td></tr>
      <tr><td colspan="2"><span style="font-family:Comic Sans MS">wide</span></td></tr></table>`);
    document.querySelector(".cs-area .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await page.locator("#save").click();
  const v = await stored(page);
  const t = v.find((b: { table?: unknown }) => b.table);
  expect(t).toEqual({ header: true, table: [
    [[{ text: [{ text: "Name", color: "#c62828" }] }], "Value"],
    [[{ text: [{ text: "Pressure", bold: true }] }], "inner a | inner b\nc | d"],
    [{ content: "wide", colspan: 2 }],
  ] });
  await expect(page.locator(".cs-area table table")).toHaveCount(0);
});
