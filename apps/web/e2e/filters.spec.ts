// Message-filter menu e2e coverage.
// The filter menu has zero side effects on the conversation when nothing has
// been said yet, but its open/close + checkbox state is fully UI-testable
// against the empty chat shell.

import { expect, test } from "@playwright/test";

test.describe("filter menu", () => {
  test("opens on click and closes on outside click", async ({ page }) => {
    await page.goto("/");

    const trigger = page.getByRole("button", { name: /Filters/ });
    await expect(trigger).toBeVisible();
    await trigger.click();

    // Menu has a "Show message types" header.
    await expect(page.getByText("Show message types")).toBeVisible();

    // Click somewhere outside (chat surface) — menu closes.
    await page.locator("main").click({ position: { x: 10, y: 200 } });
    await expect(page.getByText("Show message types")).toBeHidden();
  });

  test("closes on Escape", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /Filters/ }).click();
    await expect(page.getByText("Show message types")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByText("Show message types")).toBeHidden();
  });

  test("default state has no badge — all filters enabled", async ({ page }) => {
    await page.goto("/");

    // The badge only renders when at least one filter is disabled, so on
    // first load the trigger should contain only the icon + "Filters" label,
    // no numeric pill.
    const trigger = page.getByRole("button", { name: /Filters/ });
    // Strip whitespace; the visible text should be just "Filters".
    const txt = (await trigger.innerText()).trim();
    expect(txt).toBe("Filters");
  });

  test("disabling Tool messages shows a count badge", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: /Filters/ }).click();

    // Uncheck the "Tool" option. Each option is a <label> wrapping a
    // checkbox + text.
    const toolCheckbox = page.locator("label").filter({ hasText: "Tool" }).locator("input");
    await expect(toolCheckbox).toBeChecked();
    await toolCheckbox.uncheck();

    // Close the menu so we can inspect the trigger button's label cleanly.
    await page.keyboard.press("Escape");
    await expect(page.getByText("Show message types")).toBeHidden();

    // The trigger now contains the "1" badge.
    const trigger = page.getByRole("button", { name: /Filters/ });
    await expect(trigger).toContainText(/^Filters1$|Filters\s*1/);
  });

  test("the four expected filter options are listed", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Filters/ }).click();

    // Assertions are intentionally sequential: each option must be present
    // before we check the next, and Promise.all() would obscure which option
    // failed first.
    for (const label of ["Assistant", "Thinking", "Tool", "System"]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(page.locator("label").filter({ hasText: label })).toBeVisible();
    }
  });
});
