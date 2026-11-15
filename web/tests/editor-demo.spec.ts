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
