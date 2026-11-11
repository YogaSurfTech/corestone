import { expect, test, type Page } from "@playwright/test";

// Sign-in with local accounts (-auth local). Needs its own server started
// with no accounts: `make test-ui-auth` (CORESTONE_AUTH_URL). The other
// suites run against -auth none and skip this one.

const base = process.env.CORESTONE_AUTH_URL;
test.skip(!base, "needs a server with -auth local and no accounts (make test-ui-auth)");
test.describe.configure({ mode: "serial" });
test.use({ baseURL: base });

const admin = { name: "Ada Admin", email: "ada@example.org", password: "first-pw" };
const user = { name: "Bob User", email: "bob@example.org", password: "bob-pw" };

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/");
  const form = page.locator("[data-test=signin]");
  await expect(form.getByRole("heading")).toHaveText("Sign in");
  await form.getByLabel("Email").fill(email);
  await form.getByLabel("Password").fill(password);
  await form.getByRole("button", { name: "Sign in" }).click();
}

test("the first account is created on a new server and becomes admin", async ({ page }) => {
  await page.goto("/");
  const form = page.locator("[data-test=signin]");
  await expect(form.getByRole("heading")).toHaveText("Create the first account");
  await form.getByLabel("Name").fill(admin.name);
  await form.getByLabel("Email").fill(admin.email);
  await form.getByLabel("Password", { exact: true }).fill(admin.password);
  await form.getByLabel("Repeat password").fill("typo");
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("[data-test=signin-error]")).toHaveText("The passwords differ.");
  await form.getByLabel("Repeat password").fill(admin.password);
  await form.getByRole("button", { name: "Create account" }).click();
  await expect(page.locator("[data-test=user]")).toHaveText(admin.name);
});

test("an admin creates an account, which then signs in", async ({ page, browser }) => {
  await signIn(page, admin.email, admin.password);
  await page.locator("[data-test=user]").click();
  await expect(page.locator(".dialog h2")).toContainText("Your account");
  await page.locator("[data-test=manage]").click();
  const add = page.locator("[data-test=new-account]");
  await add.getByLabel("Name").fill(user.name);
  await add.getByLabel("Email").fill(user.email);
  await add.getByLabel("Password").fill(user.password);
  await add.getByRole("button", { name: "Create account" }).click();
  const row = page.locator(`[data-test=account-row][data-email="${user.email}"]`);
  const role = row.locator("[data-test=toggle-role]");
  await expect(role).toHaveText("user");
  await role.click(); // a commit to .corestone/access.json
  await expect(role).toHaveText("admin");
  await role.click();
  await expect(role).toHaveText("user");

  const other = await browser.newPage();
  await signIn(other, user.email, "wrong");
  await expect(other.locator("[data-test=signin-error]")).toHaveText("wrong email or password");
  await other.locator("[data-test=signin]").getByLabel("Password").fill(user.password);
  await other.locator("[data-test=signin]").getByRole("button", { name: "Sign in" }).click();
  await expect(other.locator("[data-test=user]")).toHaveText(user.name);
  await other.locator("[data-test=user]").click();
  await expect(other.locator("[data-test=manage]")).toHaveCount(0); // users do not manage accounts
  await other.close();
});

test("a user renames themselves, changes the password and signs out", async ({ page }) => {
  await signIn(page, user.email, user.password);
  await page.locator("[data-test=user]").click();
  const profile = page.locator("[data-test=profile]");
  await profile.getByLabel("Name").fill("Robert User");
  await profile.getByRole("button", { name: "Save" }).click();
  await expect(page.locator("[data-test=user]")).toHaveText("Robert User");

  const pw = page.locator("[data-test=password]");
  await pw.getByLabel("Current password").fill("nope");
  await pw.getByLabel("New password", { exact: true }).fill("new-pw");
  await pw.getByLabel("Repeat new password").fill("new-pw");
  await pw.getByRole("button", { name: "Change password" }).click();
  await expect(page.locator("[data-test=account-error]")).toHaveText("the current password is wrong");
  await pw.getByLabel("Current password").fill(user.password);
  await pw.getByRole("button", { name: "Change password" }).click();
  await expect(page.locator("[data-test=account-error]")).toHaveCount(0);
  await expect(pw.getByLabel("Current password")).toHaveValue("");

  await page.locator("[data-test=sign-out]").click();
  await expect(page.locator("[data-test=signin]")).toBeVisible();
  user.password = "new-pw";
  await signIn(page, user.email, user.password);
  await expect(page.locator("[data-test=user]")).toHaveText("Robert User");
});

test("an admin resets a password, which ends that account's sessions", async ({ page, browser }) => {
  const other = await browser.newPage();
  await signIn(other, user.email, user.password);
  await expect(other.locator("[data-test=user]")).toBeVisible();

  await signIn(page, admin.email, admin.password);
  await page.locator("[data-test=user]").click();
  await page.locator("[data-test=manage]").click();
  const row = page.locator(`[data-test=account-row][data-email="${user.email}"]`);
  await row.locator("[data-test=reset-password]").click();
  await row.getByPlaceholder("New password").fill("reset-pw");
  await row.getByRole("button", { name: "Set" }).click();
  await expect(row.locator("[data-test=reset-password]")).toBeVisible();

  await other.reload(); // the old session is gone: back to signing in
  await expect(other.locator("[data-test=signin]")).toBeVisible();
  await signIn(other, user.email, "reset-pw");
  await expect(other.locator("[data-test=user]")).toHaveText("Robert User");
  await other.close();
});

test("an admin deletes an account, which can no longer sign in", async ({ page }) => {
  await signIn(page, admin.email, admin.password);
  await page.locator("[data-test=user]").click();
  await page.locator("[data-test=manage]").click();
  const mine = page.locator(`[data-test=account-row][data-email="${admin.email}"]`);
  await expect(mine.locator("[data-test=delete-account]")).toHaveCount(0); // never your own
  const row = page.locator(`[data-test=account-row][data-email="${user.email}"]`);
  await row.locator("[data-test=delete-account]").click();
  await row.locator("[data-test=confirm-delete]").click();
  await expect(row).toHaveCount(0);

  const res = await page.request.post("/api/auth/login", { data: { email: user.email, password: "reset-pw" } });
  expect(res.status()).toBe(401);
});

test("the API refuses requests without a session", async ({ request }) => {
  expect((await request.get(base + "/api/repository")).status()).toBe(401);
  expect((await request.get(base + "/api/health")).status()).toBe(200);
});
