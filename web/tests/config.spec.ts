import { addType, defineTypes, expect, get, post, putConfig, seedDomain, stamp, test } from "./fixtures";
test("type icons support backgrounds and color-only markers", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await customElements.whenDefined("corestone-type-icon");
    for (const [id, presentation] of Object.entries({
      color: { backgroundColor: "rebeccapurple" },
      image: { icon: "testcase", backgroundColor: "rgb(10, 20, 30)" },
      fallback: {},
    })) {
      const element = document.createElement("corestone-type-icon");
      Object.assign(element, { id: `marker-${id}`, kind: "entry", schema: { type: "test", displayName: "Test", presentation } });
      document.body.append(element);
    }
  });
  const color = page.locator("#marker-color .type-icon");
  await expect(color).toHaveCSS("background-color", "rgb(102, 51, 153)");
  await expect(color).toHaveCSS("width", "16px");
  await expect(color).toHaveCSS("height", "16px");
  await expect(page.locator("#marker-color .kind-icon")).toHaveCount(0);
  await expect(page.locator("#marker-image .type-icon")).toHaveCSS("background-color", "rgb(10, 20, 30)");
  await expect(page.locator("#marker-fallback .kind-icon")).toBeVisible();
});


// The client follows the configuration (docs/CONFIGURATION.md): it offers
// only the kinds with types in a folder, shows stored fields the type no
// longer defines read-only, and suggests the values in use for extendable
// enumerations.

const id = stamp();
const folder = `cfg-${id}`;
const quiet = `${folder}/quiet`;

test.beforeAll(async () => {
  await seedDomain(folder, "C" + id.slice(-3).toUpperCase());
  await addType(folder, "entries", { id: "note", displayName: "Note",
    fields: [{ id: "topic", name: "Topic", type: "enum", extendable: true, options: [{ value: "known" }] }] });
  // A subfolder with entry types only: no documents, links or comments there.
  for (const kind of ["documents", "links", "comments"] as const) await defineTypes(quiet, kind, [], { inheritance: "off" });
});

test("only kinds with types are offered, and comments need a comment type", async ({ page }) => {
  await page.goto(`/folder/${folder}`);
  await page.locator("button", { hasText: "＋ New" }).click();
  await expect(page.locator("[data-test=new-comment]")).toBeVisible();
  await expect(page.locator("[data-test=new-document]")).toBeVisible();

  const q = await post("/entries", { path: quiet, type: "req", title: `Quiet ${id}`, fields: { priority: "low" } });
  await page.goto(`/folder/${quiet}`);
  await page.locator("button", { hasText: "＋ New" }).click();
  await expect(page.locator("[data-test=new-entry]")).toBeVisible();
  for (const k of ["document", "link", "comment"]) await expect(page.locator(`[data-test=new-${k}]`)).toHaveCount(0);

  await page.goto(`/artifact/${q.meta.guid}`);
  await expect(page.locator("[data-test=no-comment-type]")).toBeVisible();
  await expect(page.locator("[data-test=comment-text]")).toHaveCount(0);
  await expect(page.locator("[data-test=no-link-types]")).toBeVisible();
});

test("a field the type no longer defines is read-only and can be removed", async ({ page }) => {
  const e = await post("/entries", { path: folder, type: "req", title: `Legacy ${id}`, fields: { priority: "low", effort: 5 } });
  // effort is dropped from the type: the stored value stays
  await putConfig(folder, "entries/req-fields.json", { fields: [
    { id: "priority", name: "Priority", type: "enum", required: true, options: [{ value: "low" }, { value: "high" }] },
    { id: "rationale", name: "Rationale", type: "multiline" }] });
  await page.goto(`/artifact/${e.meta.guid}`);
  const field = page.locator("#sec-fields [data-field=effort]");
  await expect(field.locator(".undeclared")).toContainText("not defined for this type");
  await expect(field.locator("input")).toBeDisabled();
  await expect(field.locator("input")).toHaveValue("5");
  await field.locator("[data-test=remove-field]").click();
  await page.locator("[data-test=save]").click();
  await expect(page.locator(".toast.success", { hasText: "Saved" })).toBeVisible();
  await expect(page.locator("#sec-fields [data-field=effort]")).toHaveCount(0);
  const stored = await get<{ data: { fields: Record<string, unknown> } }>(`/entries/${e.meta.guid}`);
  expect(stored.data.fields.effort).toBeUndefined();
});

test("extendable enumerations suggest the values in use", async ({ page }) => {
  await post("/entries", { path: folder, type: "note", title: `Custom topic ${id}`, fields: { topic: `custom-${id}` } });
  const other = await post("/entries", { path: folder, type: "note", title: `Other note ${id}` });
  await page.goto(`/artifact/${other.meta.guid}`);
  const field = page.locator("#sec-fields [data-field=topic]");
  await field.locator(".enum-trigger").click();
  await expect(field.locator('.enum-option[data-value="known"]')).toBeVisible();
  await expect(field.locator(`.enum-option[data-value="custom-${id}"]`)).toBeVisible();
});
