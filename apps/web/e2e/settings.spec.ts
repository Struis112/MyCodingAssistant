import { expect, test } from "@playwright/test";

test.describe("settings view", () => {
  test("renders the three configuration sections", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // The three section titles
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "AI Model" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Thinking Level" })).toBeVisible();
  });

  test("the theme toggle button is present and switches label after click", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    const toggle = page.getByRole("button", { name: /switch to (light|dark) mode/i });
    await expect(toggle).toBeVisible();
    const beforeText = (await toggle.textContent())?.trim();
    await toggle.click();
    const afterText = (await toggle.textContent())?.trim();
    expect(afterText).not.toBe(beforeText);
  });

  test("shows at least one thinking-level option", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Settings", exact: true }).click();

    // Section exists; specific option labels may vary across UI tweaks.
    await expect(page.getByRole("heading", { name: "Thinking Level" })).toBeVisible();
    // 'off' is always rendered as the baseline option.
    const offOption = page.getByText(/^off$/i).first();
    await expect(offOption).toBeVisible();
  });
});
