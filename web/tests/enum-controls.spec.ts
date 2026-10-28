import { test, expect } from "./fixtures";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    await customElements.whenDefined("corestone-enum");
    const element = document.createElement("corestone-enum");
    Object.assign(element, {
      id: "enum-test", label: "Priority", folder: "corestone_tasks", multiple: true, extendable: true,
      options: [
        { value: "low", label: "Low", presentation: { icon: "status-green", backgroundColor: "lightblue", color: "green" } },
        { value: "high", label: "High", presentation: { backgroundColor: "red" } },
      ], value: ["low"],
    });
    document.body.append(element);
  });
});

test("vertical multiselect renders markers, selects, adds, removes and closes", async ({ page }) => {
  const control = page.locator("#enum-test");
  await expect(control.locator(".enum-marker")).toHaveCSS("background-color", "rgb(173, 216, 230)");
  await control.locator(".enum-trigger").click();
  await control.getByRole("option", { name: "High", exact: true }).click();
  await expect(control.getByRole("listbox")).toBeVisible();
  await expect(control.locator(".enum-chip")).toHaveCount(2);
  await control.getByRole("searchbox").fill("custom");
  await control.getByRole("searchbox").press("Enter");
  await expect(control.locator(".enum-chip")).toHaveCount(3);
  await control.getByRole("button", { name: "Remove custom" }).click();
  await expect(control.locator(".enum-chip")).toHaveCount(2);
  await control.getByRole("searchbox").press("Escape");
  await expect(control.getByRole("listbox")).toHaveCount(0);
  await expect(control.locator(".enum-trigger")).toBeFocused();
});

test("single select supports keyboard navigation and clearing", async ({ page }) => {
  const control = page.locator("#enum-test");
  await control.evaluate((element) => { Object.assign(element, { multiple: false, extendable: false, value: null }); });
  await control.locator(".enum-trigger").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(control.locator(".enum-selection")).toContainText("Low");
  await control.locator(".enum-trigger").click();
  await control.getByRole("option", { name: "— none —", exact: true }).click();
  await expect(control.locator(".enum-chip")).toHaveCount(0);
});

test("readonly controls have markers but no editing actions", async ({ page }) => {
  const control = page.locator("#enum-test");
  await control.evaluate((element) => { Object.assign(element, { readonly: true }); });
  await expect(control.locator(".enum-readonly")).toContainText("Low");
  await expect(control.locator(".enum-marker")).toBeVisible();
  await expect(control.getByRole("button")).toHaveCount(0);
  await expect(control.getByRole("searchbox")).toHaveCount(0);
});

test("suggestions expand after two characters and narrow again when cleared", async ({ page }) => {
  const control = page.locator("#enum-test");
  await control.evaluate((element) => {
    Object.assign(element, { suggestions: ["local"] });
    element.addEventListener("enum-query", (event) => {
      const query = (event as CustomEvent<string>).detail;
      Object.assign(element, { suggestions: query.trim().length >= 2 ? ["local", "remote"] : ["local"] });
    });
  });
  await control.locator(".enum-trigger").click();
  await expect(control.getByRole("option", { name: "local", exact: true })).toBeVisible();
  const search = control.getByRole("searchbox");
  await search.fill("r");
  await expect(control.getByRole("option", { name: "remote", exact: true })).toHaveCount(0);
  await search.fill("RE");
  await expect(control.getByRole("option", { name: "remote", exact: true })).toBeVisible();
  await search.fill("");
  await expect(control.getByRole("option", { name: "remote", exact: true })).toHaveCount(0);
});
