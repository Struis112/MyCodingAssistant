import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("root URL renders the chat shell", async ({ page }) => {
    await page.goto("/");

    // Three sidebar nav buttons exist (exact match — chat header has
    // "New chat" / "Browse sessions" which would otherwise alias).
    await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sessions", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeVisible();

    // Chat input + send button
    await expect(page.getByRole("textbox", { name: "Message input" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();

    await expect(page.getByText("Start a conversation with your AI assistant")).toBeVisible();
  });

  test("typing in the input enables the send button", async ({ page }) => {
    await page.goto("/");

    const input = page.getByRole("textbox", { name: "Message input" });
    const send = page.getByRole("button", { name: "Send message" });

    await expect(send).toBeDisabled();

    await input.fill("hello");
    await expect(send).toBeEnabled();
  });

  test("sidebar navigation switches main view", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("button", { name: "Sessions", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Sessions" })).toBeVisible();

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByText("Start a conversation with your AI assistant")).toBeVisible();
  });
});
