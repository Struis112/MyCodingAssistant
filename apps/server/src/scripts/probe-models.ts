// Empirical probe: for every model id in the Pi SDK registry whose id
// contains "opus", send a trivial prompt and count the events the harness
// emits. Models that produce zero text / thinking / tool events are aliases
// the upstream provider doesn't actually serve.
//
// Run with:
//   tsx apps/server/src/scripts/probe-models.ts
// or after build:
//   node apps/server/dist/scripts/probe-models.js
//
// Auth is picked up via the same chain as the running server
// (~/.pi/agent/auth.json or env vars like ANTHROPIC_API_KEY).

import { PiSessionManager } from "../connectors/pi/manager.js";

interface ProbeResult {
  provider: string;
  modelId: string;
  text: number;
  thinking: number;
  toolStart: number;
  toolEnd: number;
  durationMs: number;
  ok: boolean;
  error?: string;
}

const PROMPT = "Reply with exactly the single word: ok";
const TIMEOUT_MS = 30_000;

// 1×1 transparent PNG as a base64 string. Smallest possible legal PNG; used
// to test which models accept image attachments without rejecting the
// multimodal request.
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function parseFlags() {
  const args = process.argv.slice(2);
  let filter = "opus";
  let withImage = false;
  for (const a of args) {
    if (a === "--with-image" || a === "-i") withImage = true;
    else if (!a.startsWith("-")) filter = a.toLowerCase();
  }
  return { filter, withImage };
}

async function probeOne(
  mgr: PiSessionManager,
  sessionId: string,
  provider: string,
  modelId: string,
  withImage: boolean,
): Promise<ProbeResult> {
  const start = Date.now();
  const counts = { text: 0, thinking: 0, toolStart: 0, toolEnd: 0 };

  try {
    const session = await mgr.newSession(sessionId);
    await mgr.setSessionModel(sessionId, provider, modelId);
    mgr.setSessionThinkingLevel(sessionId, "off");

    let resolveTurn: () => void = () => {};
    const turnDone = new Promise<void>((res) => {
      resolveTurn = res;
    });

    const unsub = session.subscribe((event: unknown) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ev = event as any;
      if (!ev || typeof ev !== "object") return;
      if (ev.type === "message_update") {
        const sub = ev.assistantMessageEvent?.type;
        if (sub === "text_delta") counts.text += 1;
        else if (sub === "thinking_delta") counts.thinking += 1;
      } else if (ev.type === "tool_execution_start") {
        counts.toolStart += 1;
      } else if (ev.type === "tool_execution_end") {
        counts.toolEnd += 1;
      } else if (ev.type === "message_end") {
        resolveTurn();
      }
    });

    const timeout = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout ${TIMEOUT_MS}ms`)), TIMEOUT_MS),
    );

    // Pi SDK's ImageContent shape: flat `{ type, data, mimeType }`.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkImages = withImage
      ? ([
          {
            type: "image",
            data: TINY_PNG_BASE64,
            mimeType: "image/png",
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ] as any)
      : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const promptArgs: any = sdkImages ? [PROMPT, { images: sdkImages }] : [PROMPT];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.race([Promise.all([(session as any).prompt(...promptArgs), turnDone]), timeout]);
    unsub();

    return {
      provider,
      modelId,
      ...counts,
      durationMs: Date.now() - start,
      ok: counts.text > 0 || counts.toolStart > 0,
    };
  } catch (err) {
    return {
      provider,
      modelId,
      ...counts,
      durationMs: Date.now() - start,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    mgr.disposeSession(sessionId);
  }
}

function fmtRow(r: ProbeResult): string {
  const status = r.ok ? "OK   " : r.error ? "ERR  " : "EMPTY";
  const id = `${r.provider}/${r.modelId}`.padEnd(48);
  const stats =
    `text=${String(r.text).padEnd(4)} think=${String(r.thinking).padEnd(3)} tools=${r.toolStart}/${r.toolEnd}`.padEnd(
      34,
    );
  const time = `${String(r.durationMs).padStart(6)}ms`;
  const err = r.error ? `  err=${r.error}` : "";
  return `  ${status}  ${id}  ${stats}  ${time}${err}`;
}

async function main() {
  const mgr = new PiSessionManager();
  const { filter, withImage } = parseFlags();

  const all = await mgr.getAvailableModels();
  const matches = all.filter((m) => m.id.toLowerCase().includes(filter));

  if (matches.length === 0) {
    console.error(`No models matched filter "${filter}". Available ids:`);
    for (const m of all) console.error(`  ${m.provider}/${m.id}`);
    mgr.disposeAll();
    process.exit(1);
  }

  console.log(
    `Probing ${matches.length} model(s) matching "${filter}"${withImage ? " + 1×1 image" : ""} with prompt: ${JSON.stringify(PROMPT)}\n`,
  );

  const results: ProbeResult[] = [];
  for (const m of matches) {
    process.stdout.write(`  …  ${m.provider}/${m.id}`);
    // eslint-disable-next-line no-await-in-loop
    const r = await probeOne(mgr, `probe-${m.id}`, m.provider, m.id, withImage);
    // Overwrite the in-progress line with the final result.
    process.stdout.write(`\r${fmtRow(r)}\n`);
    results.push(r);
  }

  console.log();
  const okCount = results.filter((r) => r.ok).length;
  const emptyCount = results.filter((r) => !r.ok && !r.error).length;
  const errCount = results.filter((r) => r.error).length;
  console.log(`Summary: ${okCount} OK   |  ${emptyCount} EMPTY   |  ${errCount} ERR`);

  mgr.disposeAll();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
