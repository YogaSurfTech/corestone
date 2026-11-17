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
  // the image (not found) is left out
  await expect(page.locator(".cs-notice")).toContainText("left out");
  await page.locator("#save").click();
  const v = await stored(page);
  // the heading became a paragraph and kept its colour
  expect(v[0]).toEqual({ text: [{ text: "Title", color: "#c62828" }] });
  // bold kept; the unknown font dropped, its size kept; script and image gone
  const runs = v[1].text as { text: string }[];
  expect(runs.find((r) => r.text === "bold")).toEqual({ text: "bold", bold: true });
  expect(runs.find((r) => r.text === "odd font")).toEqual({ text: "odd font", size: 12 });
  expect(runs.map((r) => r.text).join("").trimEnd()).toBe("bold odd font");
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
  const item = (await insertMenu(page)).locator("[data-cmd=table]");
  const ib = (await item.boundingBox())!;
  await item.click();
  const grid = page.locator(".cs-tablegrid");
  await expect(grid).toBeVisible();
  // the grid opens with its first cell under the mouse pointer
  const fb = (await grid.locator("button").first().boundingBox())!;
  expect(Math.abs(fb.x + fb.width / 2 - (ib.x + ib.width / 2))).toBeLessThan(2);
  expect(Math.abs(fb.y + fb.height / 2 - (ib.y + ib.height / 2))).toBeLessThan(2);
  await expect(page.locator(".cs-tableprops .title")).toBeHidden();
  await grid.locator('button[data-r="2"][data-c="3"]').hover();
  await expect(grid.locator(".size")).toHaveText("3 × 2");
  await grid.locator('button[data-r="2"][data-c="3"]').click();
  await expect(page.locator(".cs-area table tr")).toHaveCount(2);
  // the properties come up right away; closing them goes back into the first cell
  const dlg = page.locator(".cs-tableprops");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator(".title")).toHaveText("Table Properties");
  await expect(dlg.locator("input.rows")).toHaveValue("2");
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator(".cs-area table th")).toHaveCount(3);
  for (const t of ["Name", "Value", "Unit", "Pressure", "16", "bar"]) {
    await page.keyboard.type(t);
    await page.keyboard.press("Tab");
  }
  await page.keyboard.type("Temp");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([
    { text: "Intro" },
    { table: [[H("Name"), H("Value"), H("Unit")], ["Pressure", "16", "bar"], ["Temp", "", ""]] },
  ]);
  // inside a table no table can be inserted
  await page.locator(".cs-area td", { hasText: "Temp" }).click();
  await insertMenu(page);
  await expect(page.locator(".cs-tb .pop.open [data-cmd=table]")).toHaveAttribute("aria-disabled", "true");
  await expect(page.locator("#plain")).toHaveText("Intro\nName | Value | Unit\nPressure | 16 | bar\nTemp |  | ");
});

test("tables: the context menu inserts columns, merges cells and formats headers", async ({ page }) => {
  await page.locator("#json").fill(JSON.stringify([{ table: [["A", "B"], ["1", "2"]] }]));
  await page.locator("#load").click();
  const menu = page.locator(".cs-tablemenu");
  await page.locator(".cs-area td", { hasText: "1" }).click({ button: "right" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Merge cells" })).toHaveCount(0); // only where it applies
  await expect(menu.getByRole("menuitem", { name: "Split cell" })).toHaveCount(0);
  await menu.getByRole("menuitem", { name: "Insert column" }).hover();
  await menu.getByRole("menuitem", { name: "Right" }).click();
  await expect(menu).toBeHidden();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ table: [["A", "", "B"], ["1", "", "2"]] }]);
  // select two cells across the row and merge them
  await page.locator(".cs-area .ProseMirror").focus();
  await page.locator(".cs-area td", { hasText: "1" }).click();
  await page.waitForTimeout(100);
  await page.keyboard.press("End");
  await page.waitForTimeout(100);
  await page.keyboard.press("Shift+ArrowRight"); // over the cell border: the two cells are selected
  await expect(page.locator(".cs-area .selectedCell")).toHaveCount(2);
  await page.locator(".cs-area td", { hasText: "1" }).click({ button: "right" });
  await expect(page.locator(".cs-area .selectedCell")).toHaveCount(2); // the right click keeps the selection
  await menu.getByRole("menuitem", { name: "Merge cells" }).click();
  await page.locator("#save").click();
  expect((await stored(page))[0].table[1]).toEqual([{ content: "1", colspan: 2 }, "2"]);
  // a column as header: select its two cells, then Format as header
  await page.locator(".cs-area .ProseMirror").focus();
  await page.locator(".cs-area td", { hasText: "B" }).click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.locator(".cs-area .selectedCell")).toHaveCount(2);
  await page.locator(".cs-area td", { hasText: "B" }).click({ button: "right" });
  await expect(menu.getByRole("menuitemcheckbox", { name: "Format as header" })).toHaveAttribute("aria-checked", "false");
  await menu.getByRole("menuitemcheckbox", { name: "Format as header" }).click();
  await page.locator("#save").click();
  expect((await stored(page))[0].table).toEqual([["A", "", H("B")], [{ content: "1", colspan: 2 }, H("2")]]);
  // again on one header cell: back to a normal cell
  await page.locator(".cs-area th", { hasText: "2" }).click();
  await page.waitForTimeout(100);
  await expect(page.locator(".cs-area .selectedCell")).toHaveCount(0);
  await page.locator(".cs-area th", { hasText: "2" }).click({ button: "right" });
  await expect(menu.getByRole("menuitemcheckbox", { name: "Format as header" })).toHaveAttribute("aria-checked", "true");
  await menu.getByRole("menuitemcheckbox", { name: "Format as header" }).click();
  await page.locator("#save").click();
  expect((await stored(page))[0].table).toEqual([["A", "", H("B")], [{ content: "1", colspan: 2 }, "2"]]);
  // the menu from the keyboard, deleting a row
  await page.locator(".cs-area .ProseMirror").focus();
  await page.locator(".cs-area td", { hasText: "A" }).click();
  await page.waitForTimeout(100);
  await page.keyboard.press("Shift+F10");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await page.keyboard.press("Shift+F10");
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await menu.getByRole("menuitem", { name: "Row", exact: true }).click();
  await page.locator("#save").click();
  expect((await stored(page))[0].table).toEqual([[{ content: "1", colspan: 2 }, "2"]]);
  // outside tables the browser's own menu stays
  await page.locator("#json").fill(JSON.stringify([{ text: "plain" }]));
  await page.locator("#load").click();
  await page.locator(".cs-area p", { hasText: "plain" }).click({ button: "right" });
  await expect(menu).toBeHidden();
});

test("tables: the properties set the size, stripes with their colors, and borders", async ({ page }) => {
  await page.locator("#json").fill(JSON.stringify([{ table: [["a", "b"], ["c", "d"]] }]));
  await page.locator("#load").click();
  const dlg = page.locator(".cs-tableprops");
  const props = async () => {
    await page.locator(".cs-area td", { hasText: "a" }).click({ button: "right" });
    await page.locator(".cs-tablemenu").getByRole("menuitem", { name: "Properties…" }).click();
    await expect(dlg).toBeVisible();
  };
  await props();
  await expect(dlg.locator("input.rows")).toHaveValue("2");
  await expect(dlg.locator("input.cols")).toHaveValue("2");
  await expect(dlg.getByRole("radio", { name: "Grid" })).toHaveAttribute("aria-checked", "true");
  await expect(dlg.locator(".colors")).toBeHidden(); // colours only with stripes
  await dlg.locator("input.rows").fill("4");
  await dlg.locator("input.cols").fill("3");
  await dlg.getByRole("radio", { name: "Striped rows" }).click();
  await expect(dlg.locator(".colors")).toBeVisible();
  await expect(dlg.locator("select.preset")).toHaveValue("theme");
  await dlg.locator("select.preset").selectOption({ label: "Blue" });
  // the second colour from the picker: the preset becomes "Custom"
  await dlg.getByRole("button", { name: "Second stripe color" }).click();
  await dlg.locator(".colorpop .sw").nth(3).click(); // the yellow marker
  await expect(dlg.locator(".colorpop")).toBeHidden();
  await expect(dlg.locator("select.preset")).toHaveValue("custom");
  await dlg.getByRole("radio", { name: "Outside only" }).click();
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect(dlg).toBeHidden();
  await expect(page.locator(".cs-area table")).toHaveClass(/cs-s-rows/);
  await expect(page.locator(".cs-area table")).toHaveClass(/cs-b-outside/);
  await expect(page.locator(".cs-area tr").nth(1).locator("td").first()).toHaveCSS("background-color", "rgb(255, 245, 157)");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ stripes: "rows", colors: ["#ffffff", "#fff59d"], borders: "outside", table: [
    ["a", "b", ""], ["c", "d", ""], ["", "", ""], ["", "", ""]] }]);
  // shrinking over cells with text asks first; no stripes drops the colours
  await props();
  await expect(dlg.locator("select.preset")).toHaveValue("custom");
  await dlg.locator("input.rows").fill("1");
  await dlg.getByRole("radio", { name: "Grid" }).click();
  await dlg.getByRole("radio", { name: "No stripes" }).click();
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect(dlg.locator(".msg")).toContainText("Apply again");
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect(dlg).toBeHidden();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ table: [["a", "b", ""]] }]);
  // the X closes without changes
  await props();
  await dlg.locator("input.cols").fill("5");
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toBeHidden();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ table: [["a", "b", ""]] }]);
});

test("tables: stored widths, spans and cell content come back unchanged", async ({ page }) => {
  const value = [
    { text: "Before" },
    { stripes: "columns", borders: "rows", widths: [200, null, 90], table: [
      [H("Property"), H("Value"), H("Unit")],
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
  expect(t).toEqual({ table: [
    [H([{ text: [{ text: "Name", color: "#c62828" }] }]), H("Value")],
    [[{ text: [{ text: "Pressure", bold: true }] }], "inner a | inner b\nc | d"],
    [{ content: "wide", colspan: 2 }],
  ] });
  await expect(page.locator(".cs-area table table")).toHaveCount(0);
});

/** A cell formatted as header, as stored. */
function H(content: unknown) { return { content, header: true }; }

/** A PNG of w × h pixels, drawn by the browser. */
async function png(page: import("@playwright/test").Page, w = 120, h = 80): Promise<string> {
  return page.evaluate(([w, h]) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d")!;
    g.fillStyle = "#1565c0";
    g.fillRect(0, 0, w, h);
    return c.toDataURL("image/png").split(",")[1];
  }, [w, h] as const);
}

test("images: upload with the image button, pick it again, resize, alternative text, original size", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("Pump ");
  await (await insertMenu(page)).locator("[data-cmd=image]").click();
  const pick = page.locator(".cs-filepop");
  await expect(pick).toBeVisible();
  await expect(pick.locator(".none")).toHaveText("No images in this entry yet.");
  await pick.locator("input[type=file]").setInputFiles({ name: "pump.png", mimeType: "image/png", buffer: Buffer.from(await png(page), "base64") });
  const img = page.locator(".cs-area .cs-img img");
  await expect(img).toHaveCount(1);
  await expect(img).toHaveJSProperty("naturalWidth", 120);
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ text: "Pump " }, { image: "pump.png" }] }]);
  // the picker offers the entry's images
  await page.locator(".cs-area .ProseMirror").focus();
  await (await insertMenu(page)).locator("[data-cmd=image]").click();
  await pick.getByRole("button", { name: "pump.png" }).click();
  await expect(img).toHaveCount(2);
  // the selected image gets a handle; dragging it sets the width
  await img.first().click();
  await expect(page.locator(".cs-area .cs-img.selected")).toHaveCount(1);
  const hb = (await page.locator(".cs-area .cs-img.selected .handle").boundingBox())!;
  await page.mouse.move(hb.x + 5, hb.y + 5);
  await page.mouse.down();
  await page.mouse.move(hb.x + 85, hb.y + 5, { steps: 5 });
  await page.mouse.up();
  await page.locator("#save").click();
  const w = (await stored(page))[0].text[1].width;
  expect(Math.abs(w - 200)).toBeLessThan(6);
  // the image's menu: alternative text, original size
  const menu = page.locator(".cs-imagemenu");
  await img.first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Alternative text…" }).click();
  await page.locator(".cs-altpop input").fill("The pump");
  await page.keyboard.press("Enter");
  await img.first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Original size" }).click();
  await page.locator("#save").click();
  expect((await stored(page))[0].text[1]).toEqual({ image: "pump.png", alt: "The pump" });
  await img.first().click({ button: "right" });
  await expect(menu.getByRole("menuitem", { name: "Original size" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ text: "Pump " }, { image: "pump.png" }] }]);
});

test("images: a pasted screenshot is stored; pasted images from HTML are copied, unreachable ones left out", async ({ page }) => {
  const b64 = await png(page, 40, 30);
  await page.locator(".cs-area .ProseMirror").click();
  await page.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], "image.png", { type: "image/png" }));
    document.querySelector(".cs-area .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  const img = page.locator(".cs-area .cs-img img");
  await expect(img).toHaveCount(1);
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ image: "image.png" }] }]);
  await page.locator(".cs-area .ProseMirror").focus();
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(150);
  await page.evaluate((b64) => {
    const dt = new DataTransfer();
    dt.setData("text/html", `<p>Web <img src="data:image/png;base64,${b64}" alt="dot"> and <img src="http://127.0.0.1:9/gone.png"> end</p>`);
    document.querySelector(".cs-area .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, b64);
  await expect(page.locator(".cs-notice")).toContainText("left out");
  await expect(img).toHaveCount(2);
  await expect(page.locator(".cs-area .cs-img.pending")).toHaveCount(0);
  await page.locator("#save").click();
  // the pasted paragraph joins the one the cursor is in
  expect(await stored(page)).toEqual([{ text: [{ image: "image.png" }, { text: "Web " }, { image: "image-2.png", alt: "dot" }, { text: " and  end" }] }]);
  // images in table cells come back unchanged
  const value = [{ table: [[[{ text: [{ image: "image.png", width: 30 }] }], "b"]] }];
  await page.locator("#json").fill(JSON.stringify(value));
  await page.locator("#load").click();
  await expect(page.locator(".cs-area td .cs-img img")).toHaveJSProperty("naturalWidth", 40);
  await page.locator("#save").click();
  expect(await stored(page)).toEqual(value);
});

test("file links: from the link popover, and by dropping a file", async ({ page }) => {
  await page.locator(".cs-area .ProseMirror").click();
  await page.keyboard.type("Manual");
  await page.waitForTimeout(100);
  await page.keyboard.press("Shift+Home");
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+k");
  await page.locator(".cs-linkpop").getByRole("button", { name: "File…" }).click();
  const pick = page.locator(".cs-filepop");
  await expect(pick.locator(".title")).toHaveText("Link to a file");
  await pick.locator("input[type=file]").setInputFiles({ name: "manual.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await expect(page.locator(".cs-area a.cs-file")).toHaveText("Manual");
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ text: "Manual", file: "manual.pdf" }] }]);
  // the bubble names the file
  await page.locator(".cs-area a.cs-file").click();
  await page.waitForTimeout(100);
  await expect(page.locator(".cs-linkbubble .tgt")).toHaveText("manual.pdf");
  // a dropped file becomes a file link at the drop point
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  const box = (await page.locator(".cs-area .ProseMirror p").last().boundingBox())!;
  await page.evaluate(([x, y]) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["a,b\n"], "data.csv", { type: "text/csv" }));
    document.querySelector(".cs-area .ProseMirror")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }, [box.x + 5, box.y + box.height / 2] as const);
  await expect(page.locator(".cs-area a.cs-file")).toHaveCount(2);
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ text: "Manual", file: "manual.pdf" }] }, { text: [{ text: "data.csv", file: "data.csv" }] }]);
});

test("formulas: written in the dialog with a preview, stored as LaTeX and a PNG; menu, editing, pasting", async ({ page }) => {
  const area = page.locator(".cs-area .ProseMirror");
  await area.click();
  await page.keyboard.type("Energy ");
  await (await insertMenu(page)).locator("[data-cmd=formula]").click();
  const dlg = page.locator(".cs-formulapop");
  await expect(dlg).toBeVisible();
  await expect(dlg.locator(".title")).toHaveText("Formula");
  const apply = dlg.getByRole("button", { name: "Apply" });
  // wrong LaTeX: MathJax's message, nothing to apply
  await dlg.locator("textarea").fill("\\frac{1}");
  await expect(dlg.locator(".msg")).not.toBeEmpty({ timeout: 15000 });
  await expect(apply).toBeDisabled();
  // Ctrl+Enter right after typing checks the text as it is now
  await dlg.locator("textarea").fill("x^");
  await page.keyboard.press("Control+Enter");
  await expect(dlg.locator(".msg")).toHaveText("ERROR: Missing superscript or subscript argument");
  await expect(dlg.locator(".msg strong")).toHaveText("ERROR:");
  await expect(apply).toBeDisabled();
  await expect(apply).toHaveAttribute("title", "ERROR: Missing superscript or subscript argument");
  await expect(dlg).toBeVisible();
  await dlg.locator("textarea").fill("E = mc^2");
  await expect(dlg.locator(".preview img")).toBeVisible();
  await expect(dlg.locator(".msg")).toBeEmpty();
  await apply.click();
  const formula = page.locator(".cs-area .cs-formula");
  await expect(formula.locator(".glyph")).toHaveCount(1);
  await page.locator("#save").click();
  let runs = (await stored(page))[0].text;
  expect(runs[0]).toEqual({ text: "Energy " });
  expect(runs[1]).toEqual({ formula: "E = mc^2", png: "formula-E_mc_2.png" });
  const inlinePng = runs[1].png;
  await expect(page.locator("#plain")).toHaveText("Energy E = mc^2");
  // the picture: a PNG of the entry, shown in its proportions, at the text's size
  const size = await page.evaluate(async (name) => {
    const f = (window as unknown as { demoFiles: Map<string, File> }).demoFiles.get(name)!;
    const b = await createImageBitmap(f);
    return { type: f.type, w: b.width, h: b.height };
  }, inlinePng);
  expect(size.type).toBe("image/png");
  expect(size.w).toBeGreaterThan(60);
  const glyph = (await formula.locator(".glyph").boundingBox())!;
  expect(Math.abs(glyph.width / glyph.height - size.w / size.h)).toBeLessThan(0.05);
  const fontSize = await area.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  expect(Math.abs(glyph.width - (size.w / 2) * (fontSize / 16))).toBeLessThan(1.5);
  // the menu: on a line of its own (a new picture, in the same file), then edit with a double click
  await formula.click({ button: "right" });
  const menu = page.locator(".cs-formulamenu");
  await menu.getByRole("menuitemcheckbox", { name: "On a line of its own" }).click();
  await expect(page.locator(".cs-area .cs-formula.display .glyph")).toHaveCount(1);
  await page.locator("#save").click();
  runs = (await stored(page))[0].text;
  expect(runs[1]).toMatchObject({ formula: "E = mc^2", display: true });
  expect(runs[1].png).toBe("formula-E_mc_2.png"); // the new picture replaces the old one
  const demoFiles = () => page.evaluate(() => [...(window as unknown as { demoFiles: Map<string, File> }).demoFiles.keys()]);
  expect(await demoFiles()).toEqual(["formula-E_mc_2.png"]);
  await formula.dblclick();
  await expect(dlg.locator("textarea")).toHaveValue("E = mc^2");
  await expect(dlg.getByRole("radio", { name: "On a line of its own" })).toHaveAttribute("aria-checked", "true");
  await dlg.getByRole("radio", { name: "In the text" }).click();
  await dlg.locator("textarea").fill("\\sqrt{a^2 + b^2}");
  await expect(apply).toBeEnabled();
  await page.keyboard.press("Control+Enter");
  await expect(dlg).toBeHidden();
  await expect(page.locator(".cs-area .cs-formula:not(.display) .glyph")).toHaveCount(1);
  await page.locator("#save").click();
  runs = (await stored(page))[0].text;
  expect(runs[1]).toEqual({ formula: "\\sqrt{a^2 + b^2}", png: "formula-sqrt_a_2_b_2.png" });
  expect(await demoFiles()).toEqual(["formula-sqrt_a_2_b_2.png"]); // the old formula's picture is removed
  // a pasted formula (LaTeX only) gets a picture; an equal formula's picture serves it
  await area.focus();
  await page.keyboard.press("Control+End");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/html", '<p> and <img data-latex="\\sqrt{a^2 + b^2}"> or <img data-latex="x_1" data-display=""></p>');
    document.querySelector(".cs-area .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".cs-area .cs-formula .glyph")).toHaveCount(3);
  await page.locator("#save").click();
  runs = (await stored(page))[0].text;
  expect(runs.filter((r: { formula?: string }) => r.formula).map((r: { formula: string; display?: boolean }) => [r.formula, !!r.display]))
    .toEqual([["\\sqrt{a^2 + b^2}", false], ["\\sqrt{a^2 + b^2}", false], ["x_1", true]]);
  expect(runs.filter((r: { png?: string }) => r.png).map((r: { png: string }) => r.png))
    .toEqual(["formula-sqrt_a_2_b_2.png", "formula-sqrt_a_2_b_2.png", "formula-x_1.png"]);
  expect(await demoFiles()).toEqual(["formula-sqrt_a_2_b_2.png", "formula-x_1.png"]);
  // delete from the menu: a picture another formula shows stays, one nobody shows goes; undo brings it back
  await formula.first().click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.locator(".cs-area .cs-formula")).toHaveCount(2);
  expect(await demoFiles()).toEqual(["formula-sqrt_a_2_b_2.png", "formula-x_1.png"]);
  await page.locator(".cs-area .cs-formula.display").click({ button: "right" });
  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.locator(".cs-area .cs-formula")).toHaveCount(1);
  expect(await demoFiles()).toEqual(["formula-sqrt_a_2_b_2.png"]);
  await area.focus();
  await page.keyboard.press("Control+z");
  await expect(page.locator(".cs-area .cs-formula.display .glyph")).toHaveCount(1);
  await expect.poll(demoFiles).toEqual(["formula-sqrt_a_2_b_2.png", "formula-x_1.png"]);
  await page.locator("#save").click();
  runs = (await stored(page))[0].text;
  expect(runs.filter((r: { png?: string }) => r.png).map((r: { png: string }) => r.png)).toEqual(["formula-sqrt_a_2_b_2.png", "formula-x_1.png"]);
});

test("resize: the bottom edge sets the height (remembered), the text scrolls; a double click fits the text again", async ({ page }) => {
  const area = page.locator(".cs-area");
  const edge = page.locator(".cs-resize");
  const before = (await area.boundingBox())!.height;
  const box = (await edge.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 120, { steps: 5 });
  await page.mouse.up();
  const sized = (await area.boundingBox())!.height;
  expect(Math.abs(sized - (before + 120))).toBeLessThan(3);
  // more text than fits: it scrolls inside, the field keeps its height
  await page.locator(".cs-area .ProseMirror").click();
  for (let i = 0; i < 30; i++) await page.keyboard.press("Enter");
  expect(Math.abs((await area.boundingBox())!.height - sized)).toBeLessThan(3);
  expect(await area.evaluate((e) => e.scrollHeight > e.clientHeight)).toBe(true);
  // remembered in this browser
  await page.reload();
  expect(Math.abs((await area.boundingBox())!.height - sized)).toBeLessThan(3);
  // the keyboard: arrows on the edge
  await edge.focus();
  await page.keyboard.press("ArrowUp");
  expect(Math.abs((await area.boundingBox())!.height - (sized - 20))).toBeLessThan(3);
  // a double click: grows with the text again, forgotten
  await edge.dblclick();
  await expect(area).not.toHaveClass(/sized/);
  await page.reload();
  await expect(area).not.toHaveClass(/sized/);
});

// Diagrams run against the draw.io stand-in (tests/drawio-stub: -drawio web/tests/drawio-stub).
test("diagrams: drawn in draw.io, stored as a PNG with the diagram inside; edited again, discarded, deleted", async ({ page }) => {
  const area = page.locator(".cs-area .ProseMirror");
  await area.click();
  await page.keyboard.type("Flow: ");
  // the demo asks the server where draw.io is
  await page.waitForFunction(() => !!(document.querySelector("cs-richtext") as unknown as { diagrams?: string }).diagrams);
  const insert = async () => {
    const item = (await insertMenu(page)).locator("[data-cmd=diagram]");
    await expect(item).not.toHaveAttribute("aria-disabled", "true");
    await item.click();
  };
  await insert();
  const pop = page.locator(".cs-diagrampop");
  await expect(pop.locator(".title")).toHaveText("New diagram");
  const drawio = page.frameLocator(".cs-diagrampop iframe");
  await expect(drawio.locator("body[data-loaded]")).toHaveCount(1);
  await drawio.locator("#xml").fill("<mxfile>first</mxfile>");
  await drawio.getByRole("button", { name: "Save & Exit" }).click();
  await expect(pop).toBeHidden();
  const img = page.locator(".cs-area .cs-diagram img");
  await expect(img).toHaveJSProperty("naturalWidth", 600);
  await page.locator("#save").click();
  expect(await stored(page)).toEqual([{ text: [{ text: "Flow: " }, { diagram: "diagram.drawio.png", width: 300 }] }]);
  // the file holds the diagram (draw.io's tEXt chunk "mxfile")
  const holds = (name: string) => page.evaluate(async (name) => {
    const f = (window as unknown as { demoFiles: Map<string, File> }).demoFiles.get(name);
    return f ? decodeURIComponent(new TextDecoder("latin1").decode(await f.arrayBuffer()).split("mxfile\0")[1]?.split("\0")[0] ?? "") : null;
  }, name);
  expect(await holds("diagram.drawio.png")).toContain("<mxfile>first</mxfile>");

  // a double click edits it: draw.io gets the diagram back; the changed diagram stays in its file
  await img.click({ button: "right" });
  await page.locator(".cs-imagemenu").getByRole("menuitem", { name: "Alternative text…" }).click();
  await page.locator(".cs-altpop input").fill("The flow");
  await page.keyboard.press("Enter");
  await img.dblclick();
  await expect(pop.locator(".title")).toHaveText("Diagram");
  await expect(drawio.locator("#xml")).toHaveValue("<mxfile>first</mxfile>");
  await drawio.locator("#xml").fill("<mxfile>second</mxfile>");
  await drawio.getByRole("button", { name: "Save & Exit" }).click();
  await expect(pop).toBeHidden();
  await page.locator("#save").click();
  expect((await stored(page))[0].text[1]).toEqual({ diagram: "diagram.drawio.png", alt: "The flow", width: 300 });
  expect(await holds("diagram.drawio.png")).toContain("second");
  expect(await page.evaluate(() => [...(window as unknown as { demoFiles: Map<string, File> }).demoFiles.keys()])).toEqual(["diagram.drawio.png"]);

  // closing with changes asks first; keep editing, then discard
  await img.click({ button: "right" });
  await page.locator(".cs-imagemenu").getByRole("menuitem", { name: "Edit diagram…" }).click();
  await expect(drawio.locator("#xml")).toHaveValue("<mxfile>second</mxfile>");
  await drawio.locator("#xml").fill("<mxfile>third</mxfile>");
  await pop.getByRole("button", { name: "Close" }).click();
  await expect(pop.locator(".ask")).toContainText("Discard the changes?");
  await pop.getByRole("button", { name: "Keep editing" }).click();
  await expect(pop.locator(".ask")).toBeHidden();
  await pop.getByRole("button", { name: "Close" }).click();
  await pop.getByRole("button", { name: "Discard" }).click();
  await expect(pop).toBeHidden();
  await page.locator("#save").click();
  expect((await stored(page))[0].text[1].diagram).toBe("diagram.drawio.png");

  // draw.io's own Exit closes without saving; Delete removes the diagram
  await img.dblclick();
  await drawio.getByRole("button", { name: "Exit", exact: true }).click();
  await expect(pop).toBeHidden();
  await img.click({ button: "right" });
  await page.locator(".cs-imagemenu").getByRole("menuitem", { name: "Delete" }).click();
  await page.locator("#save").click();
  expect(await stored(page)).toEqual("Flow: ");

  // without draw.io on the server the button says why
  await page.evaluate(() => { (document.querySelector("cs-richtext") as unknown as { diagrams?: string }).diagrams = undefined; });
  await area.click();
  const item = (await insertMenu(page)).locator("[data-cmd=diagram]");
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await item.hover();
  await expect(page.locator(".cs-tip.on")).toContainText("draw.io is not installed");
});
