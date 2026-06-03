import { describe, expect, it, vi } from "vitest";
import {
  DeployController,
  type DeployPipeline,
  type KnownGoodStore,
  type RepairAgent,
  type StepResult,
} from "./deploy-controller.js";

const ok: StepResult = { ok: true };
const fail = (logs: string): StepResult => ({ ok: false, logs });

/** A pipeline whose four steps return canned results, queued per attempt. */
function makePipeline(plan: {
  build?: StepResult[];
  validate?: StepResult[];
  activate?: StepResult[];
  verify?: StepResult[];
}): DeployPipeline {
  const q = (arr?: StepResult[]) => {
    const items = [...(arr ?? [])];
    return vi.fn(async () => items.shift() ?? ok);
  };
  return {
    build: q(plan.build),
    validate: q(plan.validate),
    activate: q(plan.activate),
    verify: q(plan.verify),
  };
}

function makeKnownGood(): KnownGoodStore & {
  mark: ReturnType<typeof vi.fn>;
  promote: ReturnType<typeof vi.fn>;
  rollback: ReturnType<typeof vi.fn>;
} {
  return {
    mark: vi.fn(async () => {}),
    promote: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}),
  };
}

/** A clock the test advances by a fixed step on each read. */
function steppingClock(stepMs: number, startMs = 0) {
  let t = startMs;
  return () => {
    const cur = t;
    t += stepMs;
    return cur;
  };
}

describe("DeployController — happy path", () => {
  it("promotes when every gate passes on the first attempt", async () => {
    const pipeline = makePipeline({});
    const knownGood = makeKnownGood();
    const repair: RepairAgent = { attempt: vi.fn(async () => true) };

    const ctrl = new DeployController({ pipeline, knownGood, repair });
    const result = await ctrl.run();

    expect(result.outcome).toBe("promoted");
    expect(result.attempts).toBe(1);
    expect(knownGood.mark).toHaveBeenCalledOnce();
    expect(knownGood.promote).toHaveBeenCalledOnce();
    expect(knownGood.rollback).not.toHaveBeenCalled();
    expect(repair.attempt).not.toHaveBeenCalled();
    expect(ctrl.getPhase()).toBe("promoted");
  });
});

describe("DeployController — repair loop", () => {
  it("rolls back, repairs, then promotes the fixed candidate", async () => {
    // Attempt 1 fails at validate; attempt 2 passes everything.
    const pipeline = makePipeline({ validate: [fail("TS2304: Cannot find name 'foo'"), ok] });
    const knownGood = makeKnownGood();
    const repair: RepairAgent = { attempt: vi.fn(async () => true) };

    const ctrl = new DeployController({ pipeline, knownGood, repair });
    const result = await ctrl.run();

    expect(result.outcome).toBe("promoted");
    expect(result.attempts).toBe(2);
    // Live was returned to known-good after the failed attempt...
    expect(knownGood.rollback).toHaveBeenCalledOnce();
    // ...and the AI got the failure context.
    const ctx = (repair.attempt as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(ctx.failedPhase).toBe("validating");
    expect(ctx.logs).toMatch(/TS2304/);
    // Journal records the rollback then the promotion.
    expect(result.journal.map((j) => j.outcome)).toEqual(["rolled_back", "promoted"]);
  });

  it("never leaves the live system on a failed candidate", async () => {
    // Fail at verify (post-activation) twice, then succeed.
    const pipeline = makePipeline({
      verify: [fail("readiness timeout"), fail("readiness timeout"), ok],
    });
    const knownGood = makeKnownGood();
    const repair: RepairAgent = { attempt: vi.fn(async () => true) };

    const ctrl = new DeployController({ pipeline, knownGood, repair });
    const result = await ctrl.run();

    expect(result.outcome).toBe("promoted");
    expect(result.attempts).toBe(3);
    // One rollback per failed activation (2), guaranteeing live safety.
    expect(knownGood.rollback).toHaveBeenCalledTimes(2);
  });
});

describe("DeployController — parking (don't throw away the effort)", () => {
  it("parks on the wall-clock budget, leaving live on known-good", async () => {
    // Always fails; AI always offers a new candidate — only the budget stops it.
    const pipeline = makePipeline({ build: [] });
    pipeline.validate = vi.fn(async () => fail("still broken"));
    const knownGood = makeKnownGood();
    const repair: RepairAgent = { attempt: vi.fn(async () => true) };

    // Clock advances 1h per read; budget 8h → it parks after a few attempts.
    const ctrl = new DeployController({
      pipeline,
      knownGood,
      repair,
      budgetMs: 8 * 60 * 60 * 1000,
      now: steppingClock(60 * 60 * 1000),
    });
    const result = await ctrl.run();

    expect(result.outcome).toBe("parked");
    expect(result.parkedReason).toBe("budget_exhausted");
    // Effort preserved: the journal has every attempt.
    expect(result.journal.length).toBeGreaterThan(0);
    expect(result.journal.at(-1)!.outcome).toBe("parked");
    // Live is on known-good (rollback called at least once during parking).
    expect(knownGood.rollback).toHaveBeenCalled();
    expect(knownGood.promote).not.toHaveBeenCalled();
    expect(ctrl.getPhase()).toBe("parked");
  });

  it("parks when the AI gives up (no new candidate)", async () => {
    const pipeline = makePipeline({ validate: [fail("broken")] });
    const knownGood = makeKnownGood();
    const repair: RepairAgent = { attempt: vi.fn(async () => false) };

    const ctrl = new DeployController({ pipeline, knownGood, repair });
    const result = await ctrl.run();

    expect(result.outcome).toBe("parked");
    expect(result.parkedReason).toBe("ai_gave_up");
    expect(result.attempts).toBe(1);
    expect(knownGood.promote).not.toHaveBeenCalled();
  });

  it("honors a secondary maxAttempts cap", async () => {
    const knownGood = makeKnownGood();
    const repair: RepairAgent = { attempt: vi.fn(async () => true) };
    const pipeline: DeployPipeline = {
      build: vi.fn(async () => ok),
      validate: vi.fn(async () => fail("nope")),
      activate: vi.fn(async () => ok),
      verify: vi.fn(async () => ok),
    };

    const ctrl = new DeployController({ pipeline, knownGood, repair, maxAttempts: 3 });
    const result = await ctrl.run();

    expect(result.outcome).toBe("parked");
    expect(result.parkedReason).toBe("max_attempts");
  });
});
