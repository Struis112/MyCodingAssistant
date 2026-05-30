// Raw dump of every event the Pi SDK emits when an image is attached.
// Lets us see whether the SDK is throwing or silently swallowing the image,
// and what (if any) events flow before message_end.
//
// Run: tsx apps/server/src/scripts/probe-image-raw.ts [modelId] [mediaTypeKey]
//   modelId      defaults to claude-opus-4-5
//   mediaTypeKey defaults to "mediaType" (camelCase, what handlers.ts sends).
//                Pass "media_type" to test Anthropic's snake_case shape.

import { PiSessionManager } from "../connectors/pi/manager.js";

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function main() {
  const modelId = process.argv[2] ?? "claude-opus-4-5";
  const mediaKey = process.argv[3] ?? "mediaType";
  const provider = "anthropic";

  const mgr = new PiSessionManager();
  const session = await mgr.newSession("probe-raw");
  await mgr.setSessionModel("probe-raw", provider, modelId);
  mgr.setSessionThinkingLevel("probe-raw", "off");

  console.log(`Model: ${provider}/${modelId}`);
  console.log(`Image mediaType key: ${mediaKey}\n`);

  let count = 0;
  let resolveTurn: () => void = () => {};
  const turnDone = new Promise<void>((res) => {
    resolveTurn = res;
  });

  session.subscribe((event: unknown) => {
    count++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = event as any;
    const subType = ev?.assistantMessageEvent?.type;
    const label = subType ? `${ev?.type}/${subType}` : ev?.type;
    // Trim huge fields so the dump stays readable.
    const summary: Record<string, unknown> = { type: label };
    if (ev?.toolName) summary.toolName = ev.toolName;
    if (ev?.delta) summary.delta = String(ev.delta).slice(0, 40);
    if (ev?.text) summary.text = String(ev.text).slice(0, 40);
    if (ev?.error) summary.error = String(ev.error).slice(0, 200);
    if (ev?.message?.role) summary.role = ev.message.role;
    if (ev?.assistantMessageEvent?.delta)
      summary.delta = String(ev.assistantMessageEvent.delta).slice(0, 40);
    console.log(`  ${String(count).padStart(3)}.`, summary);
    if (ev?.type === "message_end") resolveTurn();
  });

  // Build the image attachment with the requested key for mediaType.
  const sdkImage: Record<string, unknown> = {
    type: "image",
    source: { type: "base64", data: TINY_PNG_BASE64, [mediaKey]: "image/png" },
  };

  try {
    const promptPromise = (
      session as unknown as { prompt: (t: string, opts: unknown) => Promise<unknown> }
    ).prompt("Reply with exactly: ok", { images: [sdkImage] });
    await Promise.race([
      Promise.all([promptPromise, turnDone]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout 20s")), 20_000)),
    ]);
  } catch (err) {
    console.log(`\nPROMPT THREW:`, err instanceof Error ? err.message : err);
  }

  console.log(`\n${count} events total`);
  mgr.disposeAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
