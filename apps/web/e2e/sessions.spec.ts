// Sessions view e2e coverage.
//
// The Sessions view loads its list via the live `chat:list` socket event,
// which on a fresh install with no persisted history returns []. We exercise:
//   - sidebar entry is present and routes to Sessions
//   - header chrome (Sessions title, Refresh, New Chat) renders
//   - empty-state placeholder shows when there's nothing to resume
//   - "New Chat" routes back to the chat surface

import { expect, test } from "@playwright/test";

test.describe("sessions view", () => {
  test("sidebar entry exists and switches to the Sessions view", async ({ page }) => {
    await page.goto("/");

    const btn = page.getByRole("button", { name: "Sessions", exact: true });
    await expect(btn).toBeVisible();
    await btn.click();

    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();
  });

  test("renders Refresh and New Chat actions", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sessions", exact: true }).click();

    await expect(page.getByRole("button", { name: "Refresh list" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Start a new chat" })).toBeVisible();
  });

  test("empty state placeholder is shown when there are no persisted sessions", async ({
    page,
  }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sessions", exact: true }).click();

    // The production server boots a fresh server with no sessions; chat:list
    // returns []. The placeholder text is the giveaway.
    await expect(page.getByText("No persisted sessions yet")).toBeVisible();
  });

  test("New Chat routes back to the chat surface", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    await page.getByRole("button", { name: "Start a new chat" }).click();

    // Back on chat — the empty-state placeholder renders.
    await expect(page.getByText("Start a conversation with your AI assistant")).toBeVisible();
  });
});
