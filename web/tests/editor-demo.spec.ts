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
    { type: "paragraph", text: [{ text: "plain " }, { text: "bold", marks: { bold: true } }] },
    { type: "paragraph", text: "second line" },
  ]);
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
  expect(await stored(page)).toEqual([{ type: "paragraph", align: "center",
    text: [{ text: "Housing", marks: { color: "#1565c0", font: "Georgia", size: 14 } }] }]);

  await page.locator(".cs-tb .sp:has([data-cmd=ul], [data-cmd=ol], [data-cmd=indent], [data-cmd=outdent]) .c").click();
  await page.locator(".cs-tb .pop.open [data-cmd=ul]").click();
  await page.locator("#save").click();
  expect((await stored(page))[0]).toMatchObject({ type: "list", items: [{ blocks: [{ type: "paragraph" }] }] });

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
  expect(await stored(page)).toEqual([{ type: "paragraph", text: "line one" }, { type: "paragraph", text: "line two" }]);
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
  expect(v[0]).toEqual({ type: "paragraph", text: [{ text: "Title", marks: { color: "#c62828" } }] });
  // bold kept; the unknown font dropped, its size kept; script and image gone
  const runs = v[1].text as { text: string; marks?: Record<string, unknown> }[];
  expect(runs.find((r) => r.text === "bold")?.marks).toEqual({ bold: true });
  expect(runs.find((r) => r.text === "odd font")?.marks).toEqual({ size: 12 });
  expect(runs.map((r) => r.text).join("")).toBe("bold odd font");
  expect(v).toHaveLength(2);
  await page.screenshot({ path: "test-results/editor-demo.png", fullPage: true });
});
