import { test, expect, post, get, seedDomain, stamp, api, addType } from "./fixtures";

// Every generic field type through the schema-generated form, attachments,
// and the reference pickers.

const id = stamp();
const folder = `fields-${id}`;
let target: { guid: string; title: string };

test.beforeAll(async () => {
  await seedDomain(folder, "F" + id.slice(-3).toUpperCase());
  await addType(folder, "entries", { id: "all", displayName: "Everything", hid: { prefix: "ALL" },
    fields: [
      { id: "flag", name: "Flag", type: "boolean" },
      { id: "count", name: "Count", type: "integer" },
      { id: "ratio", name: "Ratio", type: "float" },
      { id: "price", name: "Price", type: "currency", currency: "EUR" },
      { id: "day", name: "Day", type: "date" },
      { id: "at", name: "At", type: "time" },
      { id: "when", name: "When", type: "datetime" },
      { id: "line", name: "Line", type: "text", description: "one line" },
      { id: "para", name: "Paragraph", type: "multiline" },
      { id: "rich", name: "Rich", type: "richtext" },
      { id: "one", name: "One of", type: "enum", options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] },
      { id: "many", name: "Many of", type: "enum", multiple: true, options: [{ value: "x" }, { value: "y" }, { value: "z" }] },
      { id: "free", name: "Free enum", type: "enum", extendable: true, options: [{ value: "known" }] },
      { id: "freeMany", name: "Free multiselect", type: "enum", multiple: true, extendable: true, options: [{ value: "known" }] },
      { id: "url", name: "URL", type: "hyperlink" },
      { id: "ref", name: "Reference", type: "reference", targetTypes: ["req"] },
      { id: "refs", name: "References", type: "references" },
      { id: "file", name: "File", type: "attachment" },
      { id: "blob", name: "JSON", type: "json" },
      { id: "def", name: "Defaulted", type: "text", default: "preset" },
    ] });
  const r = await post("/entries", { path: folder, type: "req", title: `Ref target ${id}`, fields: { priority: "low" } });
  target = { guid: r.meta.guid, title: `Ref target ${id}` };
});
test("enum suggestions use the item folder and expand after two characters", async ({ page }) => {
  const paths: string[] = [];
  await page.route("**/api/repository/values?*", async (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") || "";
    paths.push(path);
    await route.fulfill({ json: { values: (path ? ["local", "nested"] : ["local", "remote", "unrelated"]).map((value) => ({ value, count: 1 })) } });
  });
  const entry = await post("/entries", { path: folder, type: "all", title: "Suggestions", fields: {} });
  await page.goto(`/artifact/${entry.meta.guid}?folder=elsewhere`);
  for (const id of ["freeMany", "free"]) {
    const field = page.locator(`[data-field=${id}]`);
    await field.locator(".enum-trigger").click();
    await expect(field.locator('.enum-option[data-value="nested"]')).toBeVisible();
    const input = field.getByRole("searchbox");
    await input.fill("r");
    await expect(field.locator('.enum-option[data-value="remote"]')).toHaveCount(0);
    await input.fill("RE");
    await expect(field.locator('.enum-option[data-value="remote"]')).toBeVisible();
    await input.fill("rem");
    await expect(field.locator('.enum-option[data-value="unrelated"]')).toHaveCount(0);
    await input.fill("");
    await expect(field.locator('.enum-option[data-value="remote"]')).toHaveCount(0);
    await expect(field.locator('.enum-option[data-value="nested"]')).toBeVisible();
    await input.press("Escape");
  }
  expect(paths).toContain(folder);
  expect(paths).toContain("");
  expect(paths).not.toContain("elsewhere");
});

test("custom multiselect values save, reload, and remove", async ({ page }) => {
  const entry = await post("/entries", { path: folder, type: "all", title: "Custom multiselect", fields: { freeMany: ["known"] } });
  await page.goto(`/artifact/${entry.meta.guid}`);
  const field = page.locator("[data-field=freeMany]");
  await field.locator(".enum-trigger").click();
  const input = field.locator("input[type=search]");
  await input.fill("entered");
  await input.press("Enter");
  await expect(field.locator(".enum-chip", { hasText: "entered" })).toBeVisible();
  await input.fill("clicked");
  await field.getByRole("button", { name: "Add value", exact: true }).click();
  await input.fill("blurred");
  await page.locator("[data-test=title]").click();
  await expect(page.locator("[data-test=save]")).toBeVisible();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".savebar")).toHaveCount(0);
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${entry.meta.guid}`);
  expect(stored.data.fields.freeMany).toEqual(["known", "entered", "clicked", "blurred"]);
  await page.reload();
  await field.getByRole("button", { name: "Remove clicked", exact: true }).click();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".savebar")).toHaveCount(0);
  const after = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${entry.meta.guid}`);
  expect(after.data.fields.freeMany).toEqual(["known", "entered", "blurred"]);
});

test("all field types round-trip through the generated form", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("[data-test=new]").click();
  await page.locator("[data-test=new-entry]").click();
  await page.locator(".type-card[data-type=all]").click();
  const d = page.locator(".dialog");
  await expect(d.locator("[data-field=def] input")).toHaveValue("preset");
  await expect(d.locator("[data-field=line] .help")).toHaveText("one line");
  await d.locator("#new-title").fill("Everything filled");
  await d.locator("[data-field=flag] input[type=checkbox]").check();
  await d.locator("[data-field=count] input").fill("42");
  await d.locator("[data-field=ratio] input").fill("0.75");
  await d.locator("[data-field=price] input").fill("19.99");
  await expect(d.locator("[data-field=price]")).toContainText("EUR");
  await d.locator("[data-field=day] input").fill("2026-12-24");
  await d.locator("[data-field=at] input").fill("13:45");
  await d.locator("[data-field=when] input").fill("2026-12-24T10:30");
  await d.locator("[data-field=line] input").fill("single line");
  await d.locator("[data-field=para] textarea").fill("first line\nsecond line");
  await d.locator("[data-field=rich] .ProseMirror").click();
  await page.keyboard.type("rich *text*");
  await d.locator("[data-field=one] .enum-trigger").click();
  await d.locator('[data-field=one] .enum-option[data-value="b"]').click();
  await d.locator("[data-field=many] .enum-trigger").click();
  await d.locator('[data-field=many] .enum-option[data-value="x"]').click();
  await d.locator('[data-field=many] .enum-option[data-value="z"]').click();
  await d.locator("[data-field=free] .enum-trigger").click();
  await d.locator("[data-field=free] input").fill("brand-new");
  await d.locator("[data-field=url] input").fill("https://example.org/spec");
  await d.locator("[data-field=blob] textarea").fill('{"nested": {"n": 1}, "list": [1, 2]}');
  await d.locator("[data-field=blob] textarea").blur();
  // reference through the picker (restricted to req)
  await d.locator("[data-field=ref] button", { hasText: "Select" }).click();
  await page.locator("corestone-picker input[type=search]").fill(target.title);
  await page.locator(".picker-results .row", { hasText: target.title }).click();
  await expect(d.locator("[data-field=ref] .ref-chip")).toContainText(target.title);
  // multi reference: pick twice (same artifact is deduplicated)
  await d.locator("[data-field=refs] button").click();
  await page.locator("corestone-picker input[type=search]").fill(target.title);
  await page.locator(".picker-results .row", { hasText: target.title }).click();
  await expect(d.locator("[data-field=refs] .ref-chip")).toHaveCount(1);
  await d.locator("[data-test=create]").click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue("Everything filled");
  const guid = page.url().match(/artifact\/([0-9a-f-]{36})/)![1];
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${guid}`);
  expect(stored.data.fields).toMatchObject({
    flag: true, count: 42, ratio: 0.75, price: 19.99, day: "2026-12-24", at: "13:45", line: "single line",
    para: "first line\nsecond line", rich: "rich *text*", one: "b", many: ["x", "z"], free: "brand-new",
    url: "https://example.org/spec", ref: target.guid, refs: [target.guid], blob: { nested: { n: 1 }, list: [1, 2] }, def: "preset",
  });
  expect(String(stored.data.fields.when)).toMatch(/^2026-12-24T/);
  // the detail renders every value back
  const f = page.locator("corestone-detail");
  await expect(f.locator("[data-field=flag] input")).toBeChecked();
  await expect(f.locator("[data-field=count] input")).toHaveValue("42");
  await expect(f.locator("[data-field=one] .enum-selection")).toContainText("Beta");
  await expect(f.locator("[data-field=many] .enum-chip", { hasText: "z" })).toBeVisible();
  await expect(f.locator("[data-field=free] .enum-selection")).toContainText("brand-new");
  await expect(f.locator("[data-field=url] a")).toHaveAttribute("href", "https://example.org/spec");
  await expect(f.locator("[data-field=ref] .ref-chip")).toContainText(target.title);
  await expect(f.locator("[data-field=blob] textarea")).toHaveValue(/"nested"/);
  // editing: uncheck, clear, change enum, remove reference, invalid JSON is refused
  await f.locator("[data-field=flag] input").uncheck();
  await f.locator("[data-field=count] input").fill("");
  await f.locator("[data-field=one] .enum-trigger").click();
  await f.locator('[data-field=one] .enum-option[data-value=""]').click();
  await f.locator("[data-field=ref] .ref-chip button").click();
  await f.locator("[data-field=blob] textarea").fill("{not json");
  await f.locator("[data-field=blob] textarea").blur();
  await expect(page.locator(".toast.error")).toContainText("Invalid JSON");
  await f.locator("[data-field=blob] textarea").fill('{"ok": true}');
  await f.locator("[data-field=blob] textarea").blur();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const after = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${guid}`);
  expect(after.data.fields.flag).toBe(false);
  expect(after.data.fields.count).toBeUndefined();
  expect(after.data.fields.one).toBeUndefined();
  expect(after.data.fields.ref).toBeUndefined();
  expect(after.data.fields.blob).toEqual({ ok: true });
  // the reference chip links to the target
  await page.locator("[data-field=refs] .ref-chip a").click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(target.title);
});

test("attachments: upload, list, use in an attachment field, open, delete", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "all", title: "With files" });
  await page.goto(`/artifact/${e.meta.guid}`);
  await page.locator(".quicklinks a", { hasText: "Attachments" }).click();
  await expect(page.locator("#sec-attachments")).toContainText("Files stored in");
  await page.locator("#sec-attachments input[type=file]").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello attachment") });
  // the upload waits for Save
  await expect(page.locator("#sec-attachments .attach-row.pending-add")).toContainText("notes.txt");
  await expect(page.locator("[data-test=unsaved-summary]")).toContainText("1 attachment added");
  await page.locator("[data-test=save]").click();
  await expect(page.locator("[data-test=save]")).toHaveCount(0);
  const row = page.locator("#sec-attachments .attach-row");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("notes.txt");
  await expect(row.locator(".size")).toContainText("B");
  const href = await row.locator("a").getAttribute("href");
  const res = await fetch(base(href!));
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("hello attachment");
  // the attachment field offers the file
  await page.locator("[data-field=file] select").selectOption("notes.txt");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${e.meta.guid}`);
  expect(stored.data.fields.file).toBe("notes.txt");
  // history recorded the attachment commit (the section loads when opened)
  await page.locator(".quicklinks a", { hasText: "History" }).click();
  await expect(page.locator("#sec-history .history-row", { hasText: "Attachment notes.txt" })).toHaveCount(1);
  // delete it: the field now shows it as missing
  await row.locator("button").click();
  await expect(row).toHaveClass(/pending-remove/);
  await page.locator("[data-test=save]").click();
  await expect(page.locator("#sec-attachments .attach-row")).toHaveCount(0);
  await expect(page.locator("[data-field=file] select option[selected]")).toContainText("missing");
  const after = await get<{ attachments: unknown[] }>(`/entries/${e.meta.guid}`);
  expect(after.attachments ?? []).toEqual([]);
});

function base(href: string) {
  return href.startsWith("http") ? href : api.replace(/\/api$/, "") + href;
}

test("the server refuses undefined types and fields", async () => {
  await expect(post("/entries", { path: folder, type: "mystery", title: "No type" })).rejects.toThrow(/400.*mystery.*is not defined/);
  await expect(post("/entries", { path: folder, type: "req", title: "Extra", fields: { priority: "low", colour: "red" } }))
    .rejects.toThrow(/400.*colour.*is not defined/);
});

test("rich text: formatted in the entry, stored as paragraphs, shown and searchable", async ({ page }) => {
  const entry = await post("/entries", { path: folder, type: "all", title: "Rich entry", fields: { rich: "old plain text" } });
  await page.goto(`/artifact/${entry.meta.guid}`);
  const rich = page.locator("corestone-detail [data-field=rich]");
  // an older plain value opens in the editor
  await expect(rich.locator(".ProseMirror")).toHaveText("old plain text");
  await rich.locator(".ProseMirror").focus();
  await page.keyboard.press("Control+End");
  // the editor learns of a cursor moved by the browser (Ctrl+End) a moment later; a scripted Enter is faster
  await page.waitForTimeout(150);
  await page.keyboard.press("Enter");
  await page.keyboard.type("Housing ");
  await page.keyboard.press("Control+b");
  await page.keyboard.type("steel");
  await page.keyboard.press("Control+b");
  await rich.locator(".cs-tb .sp:has([data-cmd=ul]) .c").click();
  await rich.locator(".cs-tb .pop.open [data-cmd=ul]").click();
  await expect(page.locator("[data-test=save]")).toBeVisible();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${entry.meta.guid}`);
  expect(stored.data.fields.rich).toEqual([
    { text: "old plain text" },
    { list: "ul", text: [{ text: "Housing " }, { text: "steel", bold: true }] },
  ]);
  // back from the server: the formatting is there
  await page.reload();
  await expect(rich.locator(".ProseMirror ul li strong")).toHaveText("steel");
  // search finds the words, also across formatting
  const found = await get<{ artifacts: { guid: string }[] }>(`/repository/search?q=${encodeURIComponent("Housing steel")}&path=${folder}&subtree=true`);
  expect(found.artifacts.map((a) => a.guid)).toContain(entry.meta.guid);
  // emptied: the field is unset
  await rich.locator(".ProseMirror").focus();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" }).last()).toBeVisible();
  await expect.poll(async () => (await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${entry.meta.guid}`)).data.fields.rich).toBeUndefined();
});

test("rich text: invalid values are refused by the server", async () => {
  const r = await fetch(`${api}/entries`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: folder, type: "all", title: "Bad rich", fields: { rich: [{ text: "x", align: "left" }] } }) });
  expect(r.status).toBe(400);
});

test("rich text: links to items are picked, shown by name, opened, and kept by the server", async ({ page }) => {
  const entry = await post("/entries", { path: folder, type: "all", title: "Linking entry", fields: { rich: "read the target" } });
  await page.goto(`/artifact/${entry.meta.guid}`);
  const rich = page.locator("corestone-detail [data-field=rich]");
  await rich.locator(".ProseMirror").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Control+ArrowLeft"); // "target"
  await page.waitForTimeout(150); // the editor reads a selection made by the browser a moment later
  await page.keyboard.press("Control+k");
  await rich.locator(".cs-linkpop .pick").click();
  await page.locator("corestone-picker input[type=search]").fill(target.title);
  await page.locator(".picker-results .row", { hasText: target.title }).click();
  await expect(rich.locator(".ProseMirror a.cs-item")).toHaveText("target");
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${entry.meta.guid}`);
  expect(stored.data.fields.rich).toEqual([{ text: [{ text: "read the " }, { text: "target", ref: target.guid }] }]);
  // the bubble names the item and opens it
  await rich.locator(".ProseMirror a.cs-item").click();
  await expect(rich.locator(".cs-linkbubble .tgt")).toContainText(target.title);
  await rich.locator(".cs-linkbubble .tgt").click();
  await expect(page.locator("corestone-detail [data-test=title]")).toHaveValue(target.title);
});

test("rich text: a pasted image and an uploaded file are stored with Save, as files of the entry", async ({ page }) => {
  const entry = await post("/entries", { path: folder, type: "all", title: "Image entry", fields: { rich: "Photo:" } });
  await page.goto(`/artifact/${entry.meta.guid}`);
  const rich = page.locator("corestone-detail [data-field=rich]");
  await rich.locator(".ProseMirror").focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 48;
    c.getContext("2d")!.fillRect(0, 0, 64, 48);
    const bin = Uint8Array.from(atob(c.toDataURL("image/png").split(",")[1]), (ch) => ch.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], "image.png", { type: "image/png" }));
    document.querySelector("corestone-detail [data-field=rich] .ProseMirror")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  });
  const img = rich.locator(".cs-img img");
  await expect(img).toHaveJSProperty("naturalWidth", 64); // shown from the browser before Save
  // a file link through the link popover
  await page.keyboard.type(" manual");
  await page.waitForTimeout(100);
  await page.keyboard.press("Shift+Control+ArrowLeft");
  await page.waitForTimeout(150);
  await page.keyboard.press("Control+k");
  await rich.locator(".cs-linkpop .file").click();
  await rich.locator(".cs-filepop input[type=file]").setInputFiles({ name: "manual.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
  await expect(rich.locator(".ProseMirror a.cs-file")).toHaveText("manual");
  // both wait for Save as attachments
  await expect(page.locator(".attach-row.pending-add")).toHaveCount(2);
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> }; attachments: { name: string }[] }>(`/entries/${entry.meta.guid}`);
  const runs = (stored.data.fields.rich as { text: { image?: string }[] }[])[0].text;
  const name = runs.find((r) => r.image)?.image ?? "";
  expect(name).toMatch(/^image-\d{8}-\d{6}\.png$/);
  expect(runs).toEqual([{ text: "Photo:" }, { image: name }, { text: " " }, { text: "manual", file: "manual.pdf" }]);
  expect(stored.attachments.map((a) => a.name).sort()).toEqual([name, "manual.pdf"].sort());
  // after a reload the image comes from the server
  await page.reload();
  await expect(rich.locator(".cs-img img")).toHaveJSProperty("naturalWidth", 64);
  expect(await rich.locator(".cs-img img").getAttribute("src")).toBe(`/api/artifacts/${entry.meta.guid}/files/${encodeURIComponent(name)}`);
});

test("rich text: a formula is stored with Save as LaTeX and a PNG file of the entry", async ({ page }) => {
  const entry = await post("/entries", { path: folder, type: "all", title: "Formula entry", fields: { rich: "Energy:" } });
  await page.goto(`/artifact/${entry.meta.guid}`);
  const rich = page.locator("corestone-detail [data-field=rich]");
  await rich.locator(".ProseMirror").focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(150);
  await rich.locator(".cs-tb .sp:has([data-cmd=formula]) .c").click();
  await rich.locator(".cs-tb .pop.open [data-cmd=formula]").click();
  const dlg = rich.locator(".cs-formulapop");
  await dlg.locator("textarea").fill("E = mc^2");
  await expect(dlg.locator(".preview img")).toBeVisible({ timeout: 15000 });
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect(rich.locator(".cs-formula .glyph")).toHaveCount(1);
  await expect(page.locator(".attach-row.pending-add")).toHaveCount(1);
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> }; attachments: { name: string; size: number }[] }>(`/entries/${entry.meta.guid}`);
  const runs = (stored.data.fields.rich as { text: { formula?: string; png?: string }[] }[])[0].text;
  const png = runs[1]?.png ?? "";
  expect(runs).toEqual([{ text: "Energy:" }, { formula: "E = mc^2", png: "formula-E_mc_2.png" }]);
  expect(stored.attachments.map((a) => a.name)).toEqual([png]);
  expect(stored.attachments[0].size).toBeGreaterThan(100);
  // after a reload the picture comes from the server
  await page.reload();
  await expect(rich.locator(".cs-formula .glyph")).toHaveCount(1);
});

test("rich text: a diagram is drawn in draw.io and stored with Save as a PNG file of the entry", async ({ page }) => {
  // the test server serves the draw.io stand-in (tests/drawio-stub)
  const entry = await post("/entries", { path: folder, type: "all", title: "Diagram entry", fields: { rich: "Flow:" } });
  await page.goto(`/artifact/${entry.meta.guid}`);
  const rich = page.locator("corestone-detail [data-field=rich]");
  await rich.locator(".ProseMirror").focus();
  await page.keyboard.press("End");
  await page.waitForTimeout(150);
  await rich.locator(".cs-tb .sp:has([data-cmd=formula]) .c").click();
  await rich.locator(".cs-tb .pop.open [data-cmd=diagram]").click();
  const drawio = page.frameLocator(".cs-diagrampop iframe");
  await expect(drawio.locator("body[data-loaded]")).toHaveCount(1);
  await drawio.locator("#xml").fill("<mxfile>flow</mxfile>");
  await drawio.getByRole("button", { name: "Save & Exit" }).click();
  await expect(rich.locator(".cs-diagram img")).toHaveJSProperty("naturalWidth", 600);
  await expect(page.locator(".attach-row.pending-add")).toHaveCount(1);
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  const stored = await get<{ data: { fields: Record<string, unknown> }; attachments: { name: string }[] }>(`/entries/${entry.meta.guid}`);
  expect((stored.data.fields.rich as { text: unknown[] }[])[0].text).toEqual([{ text: "Flow:" }, { diagram: "diagram.drawio.png", width: 300 }]);
  expect(stored.attachments.map((a) => a.name)).toEqual(["diagram.drawio.png"]);
  // after a reload draw.io gets the stored diagram back from the server
  await page.reload();
  await rich.locator(".cs-diagram img").dblclick();
  await expect(drawio.locator("#xml")).toHaveValue("<mxfile>flow</mxfile>");
});

test("rich text: invalid images, file links and formulas are refused by the server", async () => {
  const bad = [[{ text: [{ image: "../x.png" }] }], [{ text: [{ text: "x", file: ".corestone.json" }] }],
    [{ text: [{ formula: "x^2" }] }], [{ text: [{ formula: "x^2", png: "x.svg" }] }], [{ text: [{ diagram: "flow.svg" }] }]];
  for (const rich of bad) {
    const res = await fetch(api + "/entries", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: folder, type: "all", title: "Bad image", fields: { rich } }) });
    expect(res.status).toBe(400);
  }
});
