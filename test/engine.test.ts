import { describe, expect, it } from "vitest";
import { Engine, type EngineEvent, type TickContext } from "../src/shared/engine";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { StatsBook, emptyDay, screenScore } from "../src/shared/stats";
import type { Settings } from "../src/shared/types";

const idle: TickContext = { idleSec: 0, screenLocked: false, suspended: false, outsideOfficeHours: false, smartPause: null };
const T0 = new Date(2026, 9, 20, 10, 0, 0).getTime();

function settings(over: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, workDuration: 60, shortBreakDuration: 10, longBreakDuration: 30, longBreakEvery: 3, ...over };
}

/** Advance the engine second by second and collect events. */
function run(engine: Engine, fromMs: number, seconds: number, ctx: Partial<TickContext> | ((t: number) => Partial<TickContext>) = {}) {
  const events: EngineEvent[] = [];
  for (let i = 1; i <= seconds; i++) {
    const t = fromMs + i * 1000;
    const c = typeof ctx === "function" ? ctx(i) : ctx;
    events.push(...engine.tick(t, { ...idle, ...c }));
  }
  return { events, now: fromMs + seconds * 1000 };
}

const types = (ev: EngineEvent[]) => ev.map((e) => e.type);

describe("Engine work/break cycle", () => {
  it("starts a short break after the work duration and resumes work after it", () => {
    const e = new Engine(settings(), T0, null, () => 0);
    e.tick(T0, idle);
    let r = run(e, T0, 60);
    expect(types(r.events)).toContain("break-start");
    expect(e.snapshot().status).toBe("break");
    expect(e.snapshot().currentBreak?.kind).toBe("short");
    r = run(e, r.now, 10);
    const end = r.events.find((x) => x.type === "break-end");
    expect(end && end.type === "break-end" && end.result).toBe("completed");
    expect(e.snapshot().status).toBe("working");
    expect(e.snapshot().breaksTaken).toBe(1);
  });

  it("makes every Nth break a long break", () => {
    const e = new Engine(settings(), T0, null, () => 0);
    e.tick(T0, idle);
    let now = T0;
    const kinds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = run(e, now, 60);
      now = r.now;
      kinds.push(e.snapshot().currentBreak!.kind);
      now = run(e, now, e.snapshot().currentBreak!.duration).now;
    }
    expect(kinds).toEqual(["short", "short", "long"]);
  });

  it("emits heads-up and countdown before the break", () => {
    const e = new Engine(settings({ reminderThreshold: 30, countdownThreshold: 10 }), T0);
    e.tick(T0, idle);
    const r = run(e, T0, 59);
    const t = types(r.events);
    expect(t.filter((x) => x === "heads-up")).toHaveLength(1);
    expect(t.filter((x) => x === "countdown")).toHaveLength(1);
    expect(t.indexOf("heads-up")).toBeLessThan(t.indexOf("countdown"));
  });

  it("snooze during a break returns to work and delays the break", () => {
    const e = new Engine(settings(), T0);
    e.tick(T0, idle);
    let r = run(e, T0, 60);
    expect(e.snapshot().status).toBe("break");
    e.snooze(20);
    expect(e.snapshot().status).toBe("working");
    expect(e.snapshot().remaining).toBe(20);
    r = run(e, r.now, 20);
    expect(e.snapshot().status).toBe("break");
  });

  it("enforces snooze limits per break", () => {
    const e = new Engine(settings({ snoozeLimitPerBreak: 1 }), T0);
    e.tick(T0, idle);
    run(e, T0, 30);
    expect(e.snooze(10)).not.toHaveLength(0);
    expect(e.snapshot().canSnooze).toBe(false);
    expect(e.snooze(10)).toHaveLength(0);
  });

  it("balanced mode unlocks skip after the delay; hardcore never", () => {
    const b = new Engine(settings({ disciplineLevel: "balanced", skipDelay: 5 }), T0);
    b.tick(T0, idle);
    let r = run(b, T0, 60);
    expect(b.snapshot().canSkip).toBe(false);
    r = run(b, r.now, 5);
    expect(b.snapshot().canSkip).toBe(true);
    expect(types(b.skip())).toEqual(["break-end"]);

    const h = new Engine(settings({ disciplineLevel: "hardcore" }), T0);
    h.tick(T0, idle);
    run(h, T0, 60);
    expect(h.snapshot().canSkip).toBe(false);
    expect(h.snapshot().canSnooze).toBe(false);
    expect(h.skip()).toHaveLength(0);
  });

  it("holds the break screen until End Break when configured", () => {
    const e = new Engine(settings({ holdBreakUntilEnded: true }), T0);
    e.tick(T0, idle);
    let r = run(e, T0, 60);
    r = run(e, r.now, 15);
    expect(types(r.events)).toContain("break-complete");
    expect(e.snapshot().status).toBe("break");
    expect(types(e.endBreak())).toEqual(["break-end"]);
  });
});

describe("Engine pauses", () => {
  it("pauses on idle, removes idle time, and resets after long absence", () => {
    const e = new Engine(settings({ workDuration: 600, idleTimeForPause: 30, idleTimeForReset: 120 }), T0);
    e.tick(T0, idle);
    let r = run(e, T0, 100);
    expect(e.snapshot().workElapsed).toBeCloseTo(100);
    // user walks away: idle counter climbs
    r = run(e, r.now, 200, (i) => ({ idleSec: i }));
    expect(e.snapshot().status).toBe("paused");
    expect(e.snapshot().pause?.reason).toBe("idle");
    // back
    r = run(e, r.now, 1, { idleSec: 0 });
    const ret = r.events.find((x) => x.type === "returned");
    expect(ret && ret.type === "returned" && ret.mode).toBe("reset");
    expect(e.snapshot().workElapsed).toBeLessThan(2);
  });

  it("resumes without reset after a short absence and subtracts idle time", () => {
    const e = new Engine(settings({ workDuration: 600, idleTimeForPause: 30, idleTimeForReset: 300 }), T0);
    e.tick(T0, idle);
    let r = run(e, T0, 100);
    r = run(e, r.now, 60, (i) => ({ idleSec: i }));
    r = run(e, r.now, 1, { idleSec: 0 });
    const ret = r.events.find((x) => x.type === "returned");
    expect(ret && ret.type === "returned" && ret.mode).toBe("resume");
    // 100 s active, ~29 s ticked while idle before the pause got detected and then subtracted
    expect(e.snapshot().workElapsed).toBeGreaterThan(99);
    expect(e.snapshot().workElapsed).toBeLessThan(103);
  });

  it("smart pause stops the clock and applies a cooldown before a due break", () => {
    const e = new Engine(settings({ smartPauseCooldown: 10 }), T0);
    e.tick(T0, idle);
    let r = run(e, T0, 55);
    r = run(e, r.now, 30, { smartPause: { reason: "meeting", detail: "Zoom" } });
    expect(e.snapshot().status).toBe("paused");
    expect(e.snapshot().workElapsed).toBeCloseTo(55);
    // 5 s of work remain, but the break waits for the 10 s cooldown after the meeting.
    r = run(e, r.now, 8);
    expect(e.snapshot().status).toBe("working");
    expect(e.snapshot().remaining).toBe(0);
    r = run(e, r.now, 3);
    expect(e.snapshot().status).toBe("break");
  });

  it("manual pause with duration resumes on its own", () => {
    const e = new Engine(settings(), T0);
    e.tick(T0, idle);
    e.pause(T0, 30);
    let r = run(e, T0, 29);
    expect(e.snapshot().status).toBe("paused");
    r = run(e, r.now, 2);
    expect(types(r.events)).toContain("resumed");
    expect(e.snapshot().status).toBe("working");
  });

  it("advance skip resets the cycle and is limited per day", () => {
    const e = new Engine(settings({ advanceSkipsPerDay: 1, disciplineLevel: "casual" }), T0);
    e.tick(T0, idle);
    run(e, T0, 40);
    expect(types(e.skip())).toEqual(["skipped-in-advance"]);
    expect(e.snapshot().workElapsed).toBe(0);
    expect(e.snapshot().canSkip).toBe(false);
  });
});

describe("Planned breaks", () => {
  it("fires at the scheduled minute once per day", () => {
    const at = new Date(2026, 9, 20, 12, 30, 0).getTime(); // Tuesday
    const e = new Engine(
      settings({
        workDuration: 3600,
        plannedBreaks: [{ id: "lunch", name: "Lunch", time: { hour: 12, minute: 30 }, durationMin: 1, days: [2], enabled: true }],
      }),
      at - 5000,
    );
    e.tick(at - 5000, idle);
    let r = run(e, at - 5000, 6);
    expect(e.snapshot().currentBreak?.kind).toBe("planned");
    expect(e.snapshot().currentBreak?.title).toBe("Lunch");
    r = run(e, r.now, 61);
    expect(e.snapshot().status).toBe("working");
    r = run(e, r.now, 30);
    expect(e.snapshot().status).toBe("working");
  });
});

describe("Persistence", () => {
  it("restores timer state from a snapshot", () => {
    const e = new Engine(settings(), T0);
    e.tick(T0, idle);
    run(e, T0, 25);
    const restored = new Engine(settings(), T0 + 60_000, e.serialize());
    expect(restored.snapshot().workElapsed).toBeCloseTo(25);
  });
});

describe("Screen score", () => {
  it("is null with little screen time and rewards breaks", () => {
    const d = emptyDay("2026-10-20");
    expect(screenScore(d, 1200)).toBeNull();
    d.screenTimeSec = 3600;
    d.sessions = [1200, 1200, 1200];
    d.breaksTaken = 3;
    expect(screenScore(d, 1200)).toBe(100);
    d.sessions = [3600];
    d.breaksTaken = 0;
    d.breaksSkipped = 3;
    expect(screenScore(d, 1200)).toBe(20);
  });

  it("aggregates focus into hourly buckets", () => {
    const book = new StatsBook();
    book.addFocus(T0, 30);
    book.addFocus(T0, 30);
    expect(book.day(T0).hourly[10]).toBe(60);
    expect(book.summary(T0, 1200).history).toHaveLength(7);
  });
});
