// Verifies the Pi SDK's actual ImageContent shape vs the broken shape that
// handlers.ts has been sending. Three runs:
//   1. broken shape   (what's in handlers.ts today): { type, source: { type, mediaType, data } }
//   2. flat-mediaType shape:                          { type, data, mediaType }
//   3. flat-mimeType  shape (per Pi SDK source):      { type, data, mimeType }
//
// Run: tsx apps/server/src/scripts/probe-image-shape.ts [modelId]

import { PiSessionManager } from "../connectors/pi/manager.js";

const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function runOnce(
  mgr: PiSessionManager,
  modelId: string,
  label: string,
  image: unknown,
): Promise<{ label: string; text: number; events: number; ms: number }> {
  const sid = `probe-shape-${label}`;
  const session = await mgr.newSession(sid);
  await mgr.setSessionModel(sid, "anthropic", modelId);
  mgr.setSessionThinkingLevel(sid, "off");

  let text = 0;
  let events = 0;
  let resolveTurn: () => void = () => {};
  const done = new Promise<void>((res) => {
    resolveTurn = res;
  });
  const unsub = session.subscribe((ev: unknown) => {
    events++;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const e = ev as any;
    if (e?.type === "message_update" && e?.assistantMessageEvent?.type === "text_delta") text++;
    if (e?.type === "message_end") resolveTurn();
  });

  const start = Date.now();
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = (session as any).prompt("Reply with exactly: ok", { images: [image] });
    await Promise.race([
      Promise.all([p, done]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 15_000)),
    ]);
  } catch (err) {
    console.log(`  ${label} threw:`, err instanceof Error ? err.message : err);
  }
  const ms = Date.now() - start;
  unsub();
  mgr.disposeSession(sid);
  return { label, text, events, ms };
}

async function main() {
  const modelId = process.argv[2] ?? "claude-opus-4-5";
  const mgr = new PiSessionManager();

  const shapes = [
    {
      label: "BROKEN (current handlers.ts) — nested source.mediaType",
      image: {
        type: "image",
        source: { type: "base64", mediaType: "image/png", data: TINY_PNG },
      },
    },
    {
      label: "flat data + mediaType (camelCase)             ",
      image: { type: "image", data: TINY_PNG, mediaType: "image/png" },
    },
    {
      label: "flat data + mimeType  (Pi SDK ImageContent)   ",
      image: { type: "image", data: TINY_PNG, mimeType: "image/png" },
    },
  ];

  console.log(`Probing ${modelId} with 3 image-payload shapes\n`);
  for (const s of shapes) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runOnce(mgr, modelId, s.label.replace(/\W+/g, "_"), s.image);
    const verdict = r.text > 0 ? "OK   " : "EMPTY";
    console.log(`  ${verdict}  ${s.label}  text=${r.text}  events=${r.events}  ${r.ms}ms`);
  }

  mgr.disposeAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
