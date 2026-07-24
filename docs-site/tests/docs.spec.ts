import { expect, test } from "@playwright/test";

test("renders the quickstart and navigates between pages", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await expect(
    page.getByRole("heading", { level: 1, name: "Quickstart" }),
  ).toBeVisible();

  if (await page.getByRole("button", { name: "Open navigation" }).isVisible()) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }
  await page.getByRole("link", { name: "Python SDK", exact: true }).click();
  await expect(page).toHaveURL(/\/docs\/python$/);
  await expect(
    page.getByRole("heading", { level: 1, name: "Python SDK" }),
  ).toBeVisible();
});

test("search routes to matching documentation", async ({ page }) => {
  await page.goto("/docs/quickstart");
  await page.getByRole("button", { name: /search documentation/i }).click();
  await page.getByRole("textbox", { name: "Search documentation" }).fill("JVM");
  await page
    .getByRole("dialog")
    .getByRole("link", { name: /JVM bridge/ })
    .click();
  await expect(page).toHaveURL(/\/docs\/jvm$/);
});

test("mobile navigation opens without covering its controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/docs/tools");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Documentation", exact: true }),
  ).toBeVisible();
  await expect(page.getByTitle("Close navigation")).toBeVisible();
});
