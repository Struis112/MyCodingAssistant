// Composer (input area) e2e coverage.
// Exercises the bits that don't require the live AI:
//   - file-picker → pending-attachment chip appears + can be removed
//   - drag-over the composer reveals the "Drop files here" overlay
//   - Shift+Enter inserts a newline in the textarea
//   - Enter on an empty input is a no-op
//   - typing toggles the Send button between disabled and enabled

import { expect, test } from "@playwright/test";

test.describe("composer — file picker", () => {
  test("picking a text file shows a chip with its name and size", async ({ page }) => {
    await page.goto("/");

    const fileInput = page.locator('input[type="file"]');
    await fileInput.setInputFiles({
      name: "hello.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("hi from playwright"),
    });

    // Chip's title attr is "<name> · <size>" — assert via the wrapping <span>.
    const chip = page.locator("span").filter({ hasText: "hello.txt" }).first();
    await expect(chip).toBeVisible();
    // Size is rendered next to the name as plain text.
    await expect(chip).toContainText(/B|KB|MB/);
  });

  test("removing a chip clears it from the pending row", async ({ page }) => {
    await page.goto("/");

    await page.locator('input[type="file"]').setInputFiles({
      name: "remove-me.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# title"),
    });

    const chip = page.locator("span").filter({ hasText: "remove-me.md" }).first();
    await expect(chip).toBeVisible();

    // Each chip has a per-file Remove button.
    await page.getByRole("button", { name: "Remove remove-me.md" }).click();
    await expect(chip).toBeHidden();
  });

  test("unsupported binary files surface a system note instead of a chip", async ({ page }) => {
    await page.goto("/");

    // application/x-msdownload is not text/* and not image/*; should be rejected.
    await page.locator('input[type="file"]').setInputFiles({
      name: "weird.bin",
      mimeType: "application/x-msdownload",
      buffer: Buffer.from([0, 1, 2, 3, 4]),
    });

    // System-item text starts with `Skipped attachment "<name>":`
    await expect(page.getByText(/Skipped attachment "weird\.bin"/)).toBeVisible();
    // …and there's no chip for the file.
    const chip = page.locator("span").filter({ hasText: "weird.bin" }).first();
    await expect(chip).toBeHidden();
  });
});

test.describe("composer — drag overlay", () => {
  test("dragenter with files reveals the drop overlay; dragleave hides it", async ({ page }) => {
    await page.goto("/");

    // The drop zone is the bordered region wrapping the textarea + buttons.
    // We dispatch dragenter on the textarea itself; React's dragenter handler
    // on the parent will pick it up via event bubbling.
    const textarea = page.getByRole("textbox", { name: "Message input" });

    // Build a DataTransfer that reports `types` containing "Files" so the
    // composer's dragEnter handler (which checks for that) opens the overlay.
    await textarea.evaluate((el) => {
      const dt = new DataTransfer();
      // Append a dummy file so types includes "Files".
      dt.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
      const evt = new DragEvent("dragenter", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      el.dispatchEvent(evt);
    });

    await expect(page.getByText("Drop files here to attach")).toBeVisible();

    // dragleave should hide the overlay (dragCounter goes back to 0).
    await textarea.evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
      const evt = new DragEvent("dragleave", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      el.dispatchEvent(evt);
    });

    await expect(page.getByText("Drop files here to attach")).toBeHidden();
  });
});

test.describe("composer — keyboard", () => {
  test("Shift+Enter inserts a newline; the message is not sent", async ({ page }) => {
    await page.goto("/");

    const input = page.getByRole("textbox", { name: "Message input" });
    await input.fill("first line");
    await input.press("Shift+Enter");
    await input.type("second line");

    // Textarea now contains both lines.
    await expect(input).toHaveValue(/first line\nsecond line/);

    // Send didn't fire — no user item rendered in the chat. The empty-state
    // placeholder is still visible (no real messages yet).
    await expect(page.getByText("Start a conversation with your AI assistant")).toBeVisible();
  });

  test("plain Enter on an empty input is a no-op", async ({ page }) => {
    await page.goto("/");

    const input = page.getByRole("textbox", { name: "Message input" });
    await input.focus();
    await input.press("Enter");

    // No content sent, empty state still showing.
    await expect(input).toHaveValue("");
    await expect(page.getByText("Start a conversation with your AI assistant")).toBeVisible();
  });

  test("typing toggles the Send button enabled state", async ({ page }) => {
    await page.goto("/");

    const send = page.getByRole("button", { name: "Send message" });
    await expect(send).toBeDisabled();

    await page.getByRole("textbox", { name: "Message input" }).fill("hi");
    await expect(send).toBeEnabled();
  });
});

test.describe("composer — accessibility", () => {
  test("the attach button has both aria-label and tooltip title", async ({ page }) => {
    await page.goto("/");
    const attach = page.getByRole("button", { name: "Attach files" });
    await expect(attach).toBeVisible();
    await expect(attach).toHaveAttribute("title", /Attach files/);
  });
});
