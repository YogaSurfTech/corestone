import { api, defineTypes, expect, get, post, seedDomain, stamp, test } from "./fixtures";

// Documents (docs/design/Corestone documents.md): one editor for the whole document, headings
// that make sections (Normal/Heading, Tab/Shift+Tab, Enter, Backspace), numbers, placed entries,
// cross-references, the outline, sidebars, conflicts.

const id = stamp();
const folder = `docs-${id}`;

test.beforeAll(async () => {
  await seedDomain(folder, "D" + id.slice(-3).toUpperCase());
});

type Node = { section?: string; title?: string; children?: Node[]; entry?: string; text?: unknown };
/** What a stored node is: a section's title, "entry", or "text". */
const what = (n: Node) => n.title ?? (n.entry ? "entry" : "text");

async function newDoc(title: string, content: Node[] = [{ text: "start" }]) {
  return post("/documents", { path: folder, type: "spec", title, content });
}

const stored = async (guid: string) => (await get<{ meta: { title: string }; data: { content: Node[]; fields: Record<string, unknown> } }>(`/documents/${guid}`)).data;

test("headings make sections: style, levels, Enter, Backspace, numbers; saved as a tree", async ({ page }) => {
  const d = await newDoc(`Editing ${id}`, []);
  await page.goto(`/artifact/${d.meta.guid}`);
  const ed = page.locator(".doc-page cs-document .ProseMirror");
  // the title is edited in the bar (the page starts with the introduction); Enter goes on to the text
  await expect(ed.locator("h1")).toHaveCount(0);
  const title = page.locator(".doc-title-input");
  await title.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" v2");
  await page.keyboard.press("Enter");
  // intro paragraph, then a heading made with the paragraph style
  await page.keyboard.type("Intro text");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Timing");
  await page.keyboard.press("Control+Alt+1");
  const titles = ed.locator(".cs-heading");
  await expect(titles).toHaveCount(1);
  await expect(titles.first()).toHaveAttribute("data-num", "1");
  // Enter in a heading starts its content
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("About timing");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Cold boot");
  await page.keyboard.press("Control+Alt+1");
  await expect(titles).toHaveCount(2);
  await expect(titles.nth(1)).toHaveAttribute("data-num", "2");
  // H+ / Tab: one level deeper (under "Timing"); H− / Shift+Tab back. H− is disabled at the top.
  // (in the heading group's menu; its main button repeats the last used one)
  const headingMenu = page.getByRole("button", { name: "More: Heading level" });
  await expect(page.getByRole("button", { name: "Heading", exact: true })).toHaveAttribute("aria-pressed", "true");
  await headingMenu.click();
  await expect(page.getByRole("button", { name: "Heading one level up" })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Heading one level deeper" }).click();
  await expect(titles.nth(1)).toHaveAttribute("data-num", "1.1");
  await expect(titles.nth(1)).toHaveClass(/cs-h2/);
  await headingMenu.click();
  await page.getByRole("button", { name: "Heading one level up" }).click();
  await expect(titles.nth(1)).toHaveAttribute("data-num", "2");
  await page.keyboard.press("Tab");
  await expect(titles.nth(1)).toHaveAttribute("data-num", "1.1");
  await page.keyboard.press("Shift+Tab");
  await expect(titles.nth(1)).toHaveAttribute("data-num", "2");
  await page.keyboard.press("Tab");
  // a third heading after it, at the same level
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Measured");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Safety");
  await page.keyboard.press("Control+Alt+1");
  await page.keyboard.press("Shift+Tab");
  await expect(titles).toHaveText(["Timing", "Cold boot", "Safety"]);
  await expect(titles.nth(2)).toHaveAttribute("data-num", "2");
  // the outline follows
  await page.locator("[data-test=sb-outline]").click();
  await expect(page.locator(".outline-row .num")).toHaveText(["1", "1.1", "2"]);
  // Ctrl+S saves the tree
  await page.keyboard.press("Control+s");
  await expect(page.locator(".toast.success", { hasText: "saved" })).toBeVisible();
  expect((await get<{ meta: { title: string } }>(`/documents/${d.meta.guid}`)).meta.title).toBe(`Editing ${id} v2`);
  let c = (await stored(d.meta.guid)).content;
  expect(c.map(what)).toEqual(["text", "Timing", "Safety"]);
  expect(c[1].children!.map(what)).toEqual(["text", "Cold boot"]);
  expect(c[1].children![1].children!.map(what)).toEqual(["text"]);
  expect(c[1].section).toMatch(/^[a-z0-9]{8}$/);
  // Backspace at the start of a heading makes it normal text: its content joins the section before
  await titles.nth(1).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(titles).toHaveText(["Timing", "Safety"]);
  await page.keyboard.press("Control+s");
  await expect(page.locator("[data-test=save]")).toHaveText("Saved");
  c = (await stored(d.meta.guid)).content;
  expect(c[1].children!.map(what)).toEqual(["text", "text", "text"]);
  // reload keeps it all
  await page.reload();
  await expect(ed.locator(".cs-heading")).toHaveText(["Timing", "Safety"]);
  // ¶ in the heading menu makes a heading normal text again
  await ed.locator(".cs-heading", { hasText: "Safety" }).click();
  await page.getByRole("button", { name: "More: Heading level" }).click();
  await page.getByRole("button", { name: "Normal text" }).click();
  await expect(ed.locator(".cs-heading")).toHaveText(["Timing"]);
  await expect(ed.locator("p", { hasText: "Safety" })).toHaveCount(1);
});

test("placed entries: insert, numbers, card, open, remove; once per document; missing shown", async ({ page }) => {
  const a = await post("/entries", { path: folder, type: "req", title: `Card A ${id}`, fields: { priority: "high" } });
  const b = await post("/entries", { path: folder, type: "req", title: `Card B ${id}`, fields: { priority: "low" } });
  const d = await newDoc(`Cards ${id}`, [{ text: "intro" }, { section: "sec00001", title: "Reqs", children: [{ text: "" }] }]);
  await page.goto(`/artifact/${d.meta.guid}`);
  const ed = page.locator(".doc-page cs-document .ProseMirror");
  const pick = async (title: string) => {
    await page.getByRole("button", { name: "Insert entries…" }).click();
    await page.locator("corestone-picker input[type=search]").fill(title);
    await page.locator(".picker-results .row", { hasText: title }).click(); // ticks it
    await page.locator("[data-test=pick-chosen]").click();
  };
  // into the section (replacing its empty paragraph), then one in the introduction
  await ed.locator("section .cs-heading").click();
  await pick(`Card A ${id}`);
  const cardA = ed.locator(`.cs-placement[data-placement="${a.meta.guid}"]`);
  await expect(cardA).toContainText(`Card A ${id}`);
  await expect(cardA).toHaveAttribute("data-num", "1-1");
  await ed.locator("p", { hasText: "intro" }).click();
  await pick(`Card B ${id}`);
  const cardB = ed.locator(`.cs-placement[data-placement="${b.meta.guid}"]`);
  await expect(cardB).toHaveAttribute("data-num", "0-1");
  // an entry already placed cannot be picked again
  await page.getByRole("button", { name: "Insert entries…" }).click();
  await page.locator("corestone-picker input[type=search]").fill(`Card A ${id}`);
  await expect(page.locator(".picker-results .row", { hasText: `Card A ${id}` })).toContainText("already in this document");
  await expect(page.locator(".picker-results .row", { hasText: `Card A ${id}` }).locator("input[type=checkbox]")).toBeDisabled();
  await page.keyboard.press("Escape");
  // saved as {entry}
  await page.locator("[data-test=save]").click();
  await expect(page.locator("[data-test=save]")).toHaveText("Saved");
  const c = (await stored(d.meta.guid)).content;
  expect(c[1]).toEqual({ entry: b.meta.guid });
  expect(c[2].children).toEqual([{ entry: a.meta.guid }]);
  // the entry sidebar shows the clicked entry
  await page.locator("[data-test=sb-entry]").click();
  await cardA.click();
  await expect(page.locator(".doc-side")).toContainText(`Card A ${id}`);
  // the context menu removes it from the document
  await cardB.click({ button: "right" });
  await page.locator(".cs-placementmenu button", { hasText: "Remove from document" }).click();
  await expect(cardB).toHaveCount(0);
  await expect(cardA).toHaveAttribute("data-num", "1-1");
  await page.locator("[data-test=save]").click();
  await expect(page.locator("[data-test=save]")).toHaveText("Saved");
  // an entry deleted from under the document is shown as missing, by its last known name
  await fetch(`${api}/entries/${a.meta.guid}`, { method: "DELETE" });
  await page.reload();
  await expect(ed.locator(".entry-card.missing")).toContainText("Missing entry");
  // double click opens a placed entry
  const other = await post("/entries", { path: folder, type: "req", title: `Card C ${id}`, fields: { priority: "low" } });
  await ed.locator("p", { hasText: "intro" }).click();
  await pick(`Card C ${id}`);
  await ed.locator(`.cs-placement[data-placement="${other.meta.guid}"] .entry-card`).dblclick();
  await page.locator(".dialog", { hasText: "Unsaved changes" }).locator("[data-test=dialog-alt]").click();
  await expect(page).toHaveURL(new RegExp(other.meta.guid));
});

test("several entries at once: chosen with checkboxes, or all matches of the search", async ({ page }) => {
  const tag = `Multi ${id}`;
  const e = await Promise.all([1, 2, 3, 4].map((n) => post("/entries", { path: folder, type: "req", title: `${tag} ${n}`, fields: { priority: "low" } })));
  const d = await newDoc(`Several ${id}`, [{ text: "intro" }]);
  await page.goto(`/artifact/${d.meta.guid}`);
  const ed = page.locator(".doc-page cs-document .ProseMirror");
  await ed.locator("p", { hasText: "intro" }).click();
  // two ticked, in the order ticked: one step, one undo
  await page.getByRole("button", { name: "Insert entries…" }).click();
  await page.locator("corestone-picker input[type=search]").fill(tag);
  await expect(page.locator("[data-test=pick-chosen]")).toBeDisabled();
  // clicks on the checkboxes themselves (as a user does), then on a row's text; a second click unticks
  const box = (n: number) => page.locator(".picker-results .row", { hasText: `${tag} ${n}` }).locator("input[type=checkbox]");
  const clickBox = async (n: number) => { const b = (await box(n).boundingBox())!; await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2); };
  for (let k = 0; k < 3; k++) { await clickBox(2); await expect(box(2)).toBeChecked({ checked: k % 2 === 0 }); }
  await expect(page.locator("[data-test=pick-chosen]")).toHaveText("Insert 1");
  await clickBox(2);
  await expect(box(2)).not.toBeChecked();
  await clickBox(3);
  await expect(box(3)).toBeChecked();
  await page.locator(".picker-results .row", { hasText: `${tag} 1` }).locator("td").nth(2).click();
  await expect(box(1)).toBeChecked();
  await expect(page.locator(".picker-results input[type=checkbox]:checked")).toHaveCount(2);
  await expect(page.locator("[data-test=pick-chosen]")).toHaveText("Insert 2");
  await page.locator("[data-test=pick-chosen]").click();
  const cards = ed.locator(".cs-placement");
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute("data-placement", e[2].meta.guid);
  await expect(cards.nth(1)).toHaveAttribute("data-placement", e[0].meta.guid);
  await page.keyboard.press("Control+z");
  await expect(cards).toHaveCount(0);
  await page.keyboard.press("Control+y");
  await expect(cards).toHaveCount(2);
  // all matches: those already placed are left out
  await page.getByRole("button", { name: "Insert entries…" }).click();
  await page.locator("corestone-picker input[type=search]").fill(tag);
  await expect(page.locator("[data-test=picker-count]")).toHaveText("4 matches");
  await page.locator("[data-test=pick-all]").click();
  await expect(cards).toHaveCount(4);
  await expect(cards.nth(1)).toHaveAttribute("data-placement", e[0].meta.guid);
});

test("selected text becomes a new entry, created only with the save; an entry becomes text again", async ({ page }) => {
  // a folder whose only entry type has a rich-text field (choosing the type comes later)
  const conv = `conv-${id}`;
  await defineTypes(conv, "entries", [{ id: "note", displayName: "Note", fields: [{ id: "body", name: "Body", type: "richtext" }] }]);
  await defineTypes(conv, "documents", [{ id: "spec", displayName: "Specification" }]);
  const notes = conv;
  const long = `A single paragraph ${id} that is longer than forty characters`;
  const d = await post("/documents", { path: conv, type: "spec", title: `Convert ${id}`, content: [
    { text: "before" }, { text: `Made here ${id}` }, { text: [{ text: "Body ", bold: true }, { text: "line" }] }, { text: "after" }, { text: long }] });
  await page.goto(`/artifact/${d.meta.guid}`);
  const ed = page.locator(".doc-page cs-document .ProseMirror").first(); // (cards hold editors too)
  const menu = page.getByRole("button", { name: "More: Entries" });
  const found = async (q: string) => (await get<{ total: number }>(`/repository/search?q=${encodeURIComponent(q)}&kind=entry`)).total;
  // nothing selected: the button says why
  await ed.locator("p", { hasText: "before" }).click();
  await menu.click();
  await expect(page.getByRole("button", { name: "Convert selection to entry" })).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");
  // two paragraphs: the first is the title, the second the text; no dialog, nothing on the server yet
  await ed.locator("p", { hasText: "Made here" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
  await menu.click();
  await page.getByRole("button", { name: "Convert selection to entry" }).click();
  await expect(page.locator(".dialog")).toHaveCount(0);
  const card = ed.locator(".cs-placement");
  await expect(card).toContainText(`Made here ${id}`);
  await expect(card).toContainText("Body line");
  await expect(card.locator(".pill.unsaved")).toHaveText("not saved yet");
  await expect(ed.locator("> p")).toHaveText(["before", "after", long]);
  expect(await found(`Made here ${id}`)).toBe(0);
  // undo brings the text back, redo the card; still nothing on the server
  await page.keyboard.press("Control+z");
  await expect(card).toHaveCount(0);
  await expect(ed.locator("> p")).toHaveText(["before", `Made here ${id}`, "Body line", "after", long]);
  await page.keyboard.press("Control+y");
  await expect(card).toHaveCount(1);
  // a single paragraph: it is the text, its start the title (to the end of the word at 40 characters)
  await ed.locator("p", { hasText: "single paragraph" }).click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await menu.click();
  await page.locator(".pop.open").getByRole("button", { name: "Convert selection to entry" }).click();
  await expect(card).toHaveCount(2);
  const cut = 40 + long.slice(40).search(/\s|$/);
  await expect(card.nth(1).locator(".title")).toHaveText(long.slice(0, cut));
  await expect(card.nth(1)).toContainText(long);
  // saved: created with the document, one commit; the GUIDs replace the keys
  await page.locator("[data-test=save]").click();
  await expect(page.locator("[data-test=save]")).toHaveText("Saved");
  await expect(card.locator(".pill.unsaved")).toHaveCount(0);
  expect(await found(`Made here ${id}`)).toBe(1);
  const guid = (await card.first().getAttribute("data-placement"))!;
  expect(guid).toMatch(/^[0-9a-f-]{36}$/);
  const entry = await get<{ meta: { title: string }; data: { fields: Record<string, unknown> } }>(`/entries/${guid}`);
  expect(entry.meta.title).toBe(`Made here ${id}`);
  expect(entry.data.fields.body).toEqual([{ text: [{ text: "Body ", bold: true }, { text: "line" }] }]);
  const content = (await stored(d.meta.guid)).content;
  expect(content[1]).toEqual({ entry: guid });
  expect(JSON.stringify(content)).not.toContain("new:");
  const hist = await get<{ history: { subject: string }[] }>(`/artifacts/${d.meta.guid}/history`);
  expect(hist.history[0].subject).toContain("2 entries added");
  // the placed entry selected: the same button turns it into text (the entry stays)
  await card.first().click();
  await menu.click();
  await expect(page.locator(".pop.open").getByRole("button", { name: "Turn the entry into text" })).toBeVisible();
  await page.locator(".pop.open").getByRole("button", { name: "Turn the entry into text" }).click();
  await expect(card).toHaveCount(1);
  await expect(ed.locator("> p").nth(1)).toHaveText(`Made here ${id}`);
  await expect(ed.locator("> p").nth(1).locator("strong, b")).toHaveText(`Made here ${id}`);
  expect((await get<{ meta: { title: string } }>(`/entries/${guid}`)).meta.title).toBe(`Made here ${id}`);
  // an entry's pictures become files of the document (saved with it)
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const pic = await post("/entries", { path: notes, type: "note", title: `Pictured ${id}`, fields: { body: [{ text: [{ image: "dot.png" }] }] } });
  const up = await fetch(`${api}/artifacts/${pic.meta.guid}/files/dot.png`, { method: "PUT", body: png });
  expect(up.ok).toBe(true);
  await ed.locator("> p", { hasText: "after" }).click();
  await menu.click(); // (the main button repeats the last used one)
  await page.locator(".pop.open").getByRole("button", { name: "Insert entries…" }).click();
  await page.locator("corestone-picker input[type=search]").fill(`Pictured ${id}`);
  await page.locator(".picker-results .row", { hasText: `Pictured ${id}` }).click();
  await page.locator("[data-test=pick-chosen]").click();
  const picCard = ed.locator(`.cs-placement[data-placement="${pic.meta.guid}"]`);
  await picCard.click({ button: "right" });
  await page.locator(".cs-placementmenu button", { hasText: "Turn into text" }).click();
  await expect(picCard).toHaveCount(0);
  await expect(ed.locator("img[data-file='dot.png']")).toBeVisible();
  await page.locator("[data-test=save]").click();
  await expect(page.locator("[data-test=save]")).toHaveText("Saved");
  const doc = await get<{ attachments?: { name: string }[]; data: { content: Node[] } }>(`/documents/${d.meta.guid}`);
  expect((doc.attachments ?? []).map((a) => a.name)).toContain("dot.png");
  expect(JSON.stringify(doc.data.content)).toContain('"image":"dot.png"');
});

test("outline: sections move with their grip, before a row or to the end", async ({ page }) => {
  const d = await newDoc(`Outline ${id}`, [
    { section: "bbbb0001", title: "Alpha", children: [] },
    { section: "bbbb0002", title: "Beta", children: [{ section: "bbbb0003", title: "Beta one", children: [] }] },
    { section: "bbbb0004", title: "Gamma", children: [] },
  ]);
  await page.goto(`/artifact/${d.meta.guid}?sb=outline`);
  const rows = page.locator(".outline-row .t");
  await expect(rows).toHaveText(["Alpha", "Beta", "Beta one", "Gamma"]);
  const grip = (t: string) => page.locator(".outline-row", { hasText: t }).locator(".grip");
  // Gamma before Alpha
  // (dropped on a row's upper half: before it)
  await grip("Gamma").dragTo(page.locator(".outline-row", { hasText: "Alpha" }), { targetPosition: { x: 30, y: 4 } });
  await expect(rows).toHaveText(["Gamma", "Alpha", "Beta", "Beta one"]);
  await expect(page.locator(".outline-row .num")).toHaveText(["1", "2", "3", "3.1"]);
  // into a section: before its subsection, at that level
  await grip("Gamma").dragTo(page.locator(".outline-row", { hasText: "Beta one" }), { targetPosition: { x: 30, y: 4 } });
  await expect(rows).toHaveText(["Alpha", "Beta", "Gamma", "Beta one"]);
  await expect(page.locator(".outline-row .num")).toHaveText(["1", "2", "2.1", "2.2"]);
  // to the end: below the last row a line shows under it (above a row, a line above that row)
  const dragOver = async (box: { x: number; y: number; height: number } | null, dy: number) => {
    // (the test's drag reports a position with the next move, so each position is moved to twice)
    for (const dx of [20, 22]) {
      await page.mouse.move(box!.x + dx, box!.y + dy, { steps: 3 });
      await page.waitForTimeout(100);
    }
  };
  await grip("Gamma").hover();
  await page.mouse.down();
  const alpha = await page.locator(".outline-row", { hasText: "Alpha" }).boundingBox();
  await dragOver(alpha, 4);
  await expect(page.locator(".outline-row.drop-before .t")).toHaveText("Alpha");
  const lastRow = await page.locator(".outline-row").last().boundingBox();
  await dragOver(lastRow, lastRow!.height - 3);
  await expect(page.locator(".outline-row.drop-after .t")).toHaveText("Beta one");
  await page.mouse.up();
  await expect(rows).toHaveText(["Alpha", "Beta", "Beta one", "Gamma"]);
  await expect(page.locator(".outline-row .num")).toHaveText(["1", "2", "2.1", "3"]);
});

test("cross-references show the current number and title and follow renames", async ({ page }) => {
  const d = await newDoc(`Xref ${id}`, [
    { text: "see " },
    { section: "aaaa0001", title: "Timing", children: [] },
    { section: "aaaa0002", title: "Safety", children: [] },
  ]);
  const guid = d.meta.guid;
  await page.goto(`/artifact/${guid}`);
  const ed = page.locator(".doc-page cs-document .ProseMirror");
  await ed.locator("p", { hasText: "see" }).click();
  await page.keyboard.press("End");
  await page.getByRole("button", { name: "More: Insert" }).click();
  await page.getByRole("button", { name: "Cross-reference…" }).click();
  await page.locator(".cs-xrefpop .filter").fill("Safety");
  await page.keyboard.press("Enter");
  const x = ed.locator(".cs-xref");
  await expect(x).toHaveText("2 Safety");
  // Tab under Timing: the reference follows
  await ed.locator(".cs-heading", { hasText: "Safety" }).click();
  await page.keyboard.press("Tab");
  await expect(x).toHaveText("1.1 Safety");
  await page.locator("[data-test=save]").click();
  await expect(page.locator("[data-test=save]")).toHaveText("Saved");
  const c = (await stored(guid)).content;
  const runs = (c[0] as { text: { ref?: string; xref?: boolean }[] }).text;
  expect(runs.some((r) => r.ref === `${guid}#aaaa0002` && r.xref)).toBe(true);
});

test("sidebars: properties with schema fields, comments, relationships, versions; conflict on save", async ({ page }) => {
  const d = await newDoc(`Sidebars ${id}`);
  const other = await post("/entries", { path: folder, type: "req", title: `Related doc target ${id}`, fields: { priority: "low" } });
  await post("/links", { type: "related", source: d.meta.guid, target: other.meta.guid });
  await page.goto(`/artifact/${d.meta.guid}?sb=props,rel,comments,versions`);
  const side = page.locator(".doc-side");
  await expect(side).toContainText("Document properties");
  await expect(side.locator("[data-field=audience] .enum-trigger")).toBeVisible();
  await expect(side).toContainText(`Related doc target ${id}`);
  // a comment from the sidebar
  await side.locator("textarea").fill("from the sidebar");
  await side.locator("button", { hasText: "Post" }).click();
  await expect(side.locator(".comment .text")).toHaveText("from the sidebar");
  // a schema field edit through the properties sidebar is saved with the document
  await side.locator("[data-field=audience] .enum-trigger").click();
  await side.locator('[data-field=audience] .enum-option[data-value="customer"]').click();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "saved" })).toBeVisible();
  expect((await stored(d.meta.guid)).fields.audience).toBe("customer");
  // a change elsewhere to another part is merged: the text here, the title there
  await page.locator(".doc-page cs-document .ProseMirror p").first().click();
  await page.keyboard.type(" local");
  let res = await fetch(`${api}/documents/${d.meta.guid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "changed elsewhere" }) });
  expect(res.ok).toBeTruthy();
  await page.locator("[data-test=save]").click();
  await expect(page.locator("[data-test=save]")).toHaveText("Saved");
  await expect(page.locator(".doc-title-input")).toHaveValue("changed elsewhere");
  // a conflict (the same part changed in both places) is refused: a notice with reload
  await page.locator(".doc-page cs-document .ProseMirror p").first().click();
  await page.keyboard.type(" again");
  res = await fetch(`${api}/documents/${d.meta.guid}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: [{ text: "rewritten elsewhere" }] }) });
  expect(res.ok).toBeTruthy();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".doc-main .notice.error")).toContainText("modified");
  await page.locator(".doc-main .notice.error button", { hasText: "Reload" }).click();
  await expect(page.locator(".doc-page cs-document .ProseMirror p").first()).toHaveText("rewritten elsewhere");
  // sidebars are deep-linked: turning one off updates the URL
  await page.locator("[data-test=sb-versions]").click();
  await expect(page).toHaveURL(/sb=props,rel,comments(&|$)/);
  // each sidebar closes with its own button
  await side.locator("[data-test=close-comments]").click();
  await expect(page).toHaveURL(/sb=props,rel(&|$)/);
});

test("document creation from the + menu starts with an empty page", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.keyboard.press("n");
  await expect(page.locator(".dialog")).toBeVisible();
  await page.locator(".type-card[data-type=spec]").click();
  await page.locator("#new-title").fill(`Fresh ${id}`);
  await page.locator(".dialog [data-field=audience] .enum-trigger").click();
  await page.locator('.dialog [data-field=audience] .enum-option[data-value="internal"]').click();
  await page.locator("[data-test=create]").click();
  await expect(page.locator(".doc-title-input")).toHaveValue(`Fresh ${id}`);
  await expect(page.locator("[data-test=save]")).toBeDisabled();
  await page.locator(".doc-page cs-document .ProseMirror").click();
  await page.keyboard.type("Hello");
  await expect(page.locator("[data-test=save]")).toBeEnabled();
  // close without saving: asked first; discarding keeps the stored content
  await page.locator(".doc-toolbar button[aria-label='Back to overview']").click();
  await page.locator(".dialog", { hasText: "Unsaved changes" }).locator("[data-test=dialog-alt]").click();
  await expect(page.locator("corestone-document")).toHaveCount(0);
});

test("the old block format is refused", async () => {
  const res = await fetch(`${api}/documents`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: folder, type: "spec", title: "old", content: [{ id: "b0", type: "paragraph", text: "x" }] }) });
  expect(res.status).toBe(400);
});
