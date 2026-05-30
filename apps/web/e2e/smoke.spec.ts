import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("root URL renders the chat shell", async ({ page }) => {
    await page.goto("/");

    // Three sidebar nav buttons (Chat + Sessions + Settings).
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

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();

    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(page.getByText("Start a conversation with your AI assistant")).toBeVisible();
  });

  test("the empty-state placeholder is centered in the messages region", async ({ page }) => {
    await page.goto("/");

    // The empty-state block is the parent of the placeholder text.
    const emptyState = page.locator("div", { hasText: /^Start a conversation/ }).first();
    await expect(emptyState).toBeVisible();

    // The messages region is the scrollable area between the header and the
    // composer; we walk up to it.
    const handle = await emptyState.evaluateHandle((el) => {
      // `el` is typed `SVGElement | HTMLElement`; use the common Element base
      // so `parentElement` (returns HTMLElement | null) is always assignable.
      let cur: Element | null = el;
      while (cur && !cur.classList.contains("overflow-y-auto")) {
        cur = cur.parentElement;
      }
      return cur;
    });

    const region = await handle.asElement()!.boundingBox();
    const placeholder = await emptyState.boundingBox();
    expect(region).not.toBeNull();
    expect(placeholder).not.toBeNull();
    if (!region || !placeholder) return;

    // Horizontal: the placeholder's centre should sit within 1px of the
    // region's centre (it uses items-center on a flex-col).
    const placeholderCx = placeholder.x + placeholder.width / 2;
    const regionCx = region.x + region.width / 2;
    expect(Math.abs(placeholderCx - regionCx)).toBeLessThan(2);

    // Vertical: justify-center should keep the placeholder roughly centred
    // — require its centre to be within 8% of the region's height of the
    // region's vertical centre (more slack since text wrapping can shift it).
    const placeholderCy = placeholder.y + placeholder.height / 2;
    const regionCy = region.y + region.height / 2;
    expect(Math.abs(placeholderCy - regionCy)).toBeLessThan(region.height * 0.08);
  });
});
