// Break timer state machine. Pure logic: time and environment are passed in, so it
// runs identically on macOS and Windows and is fully unit-testable.
import { breakCopy } from "./messages";
import type { BreakInfo, BreakKind, EngineSnapshot, PauseReason, Settings } from "./types";

export interface TickContext {
  /** Seconds since the last keyboard/mouse input. */
  idleSec: number;
  screenLocked: boolean;
  suspended: boolean;
  outsideOfficeHours: boolean;
  /** Active smart-pause condition (deep focus app, meeting, fullscreen), if any. */
  smartPause: { reason: PauseReason; detail?: string } | null;
}

export type EngineEvent =
  | { type: "heads-up"; secondsLeft: number; isLong: boolean }
  | { type: "countdown"; secondsLeft: number }
  | { type: "break-start"; info: BreakInfo }
  | { type: "break-complete"; info: BreakInfo }
  | { type: "break-end"; info: BreakInfo; result: "completed" | "skipped" | "snoozed" }
  | { type: "skipped-in-advance" }
  | { type: "snoozed"; seconds: number }
  | { type: "paused"; reason: PauseReason; detail?: string }
  | { type: "resumed"; reason: PauseReason }
  | { type: "returned"; awaySec: number; mode: "resume" | "reset" }
  | { type: "wellness"; kind: "blink" | "posture" }
  | { type: "session-end"; lengthSec: number }
  | { type: "focus-tick"; seconds: number }
  | { type: "day-rollover" };

/** Persisted across app restarts so a relaunch does not reset the cycle. */
export interface EngineState {
  status: EngineSnapshot["status"];
  workElapsed: number;
  sessionElapsed: number;
  breaksTaken: number;
  manualPause: { until: number | null } | null;
  currentBreak: (BreakInfo & { completeNotified: boolean }) | null;
  snoozesThisBreak: number;
  day: string;
  snoozesToday: number;
  skipsToday: number;
  advanceSkipsToday: number;
  plannedFired: Record<string, string>;
}

const MAX_TICK_SEC = 5;

export const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export class Engine {
  private s: EngineState;
  private lastTick: number | null = null;
  private autoPause: { reason: PauseReason; detail?: string } | null = null;
  private awayStartedAt: number | null = null;
  private awayIdleCorrection = 0;
  private smartPauseCooldownUntil = 0;
  private headsUpShown = false;
  private countdownShown = false;
  private blinkElapsed = 0;
  private postureElapsed = 0;
  private lastReturn: { workElapsed: number; sessionElapsed: number } | null = null;

  constructor(
    private settings: Settings,
    now: number,
    restored?: EngineState | null,
    private rand: () => number = Math.random,
  ) {
    this.s = restored ? { ...restored } : Engine.freshState(now);
    if (this.s.status === "break" && !this.s.currentBreak) this.s.status = "working";
    if (this.s.manualPause?.until != null && this.s.manualPause.until <= now) this.s.manualPause = null;
  }

  static freshState(now: number): EngineState {
    return {
      status: "working",
      workElapsed: 0,
      sessionElapsed: 0,
      breaksTaken: 0,
      manualPause: null,
      currentBreak: null,
      snoozesThisBreak: 0,
      day: dayKey(now),
      snoozesToday: 0,
      skipsToday: 0,
      advanceSkipsToday: 0,
      plannedFired: {},
    };
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
  }

  serialize(): EngineState {
    return JSON.parse(JSON.stringify(this.s));
  }

  // ---------------------------------------------------------------- queries

  get nextBreakIsLong(): boolean {
    const { longBreakEnabled, longBreakEvery } = this.settings;
    return longBreakEnabled && longBreakEvery > 0 && (this.s.breaksTaken + 1) % longBreakEvery === 0;
  }

  private get remaining(): number {
    return Math.max(0, this.settings.workDuration - this.s.workElapsed);
  }

  private skipUnlocksIn(): number {
    const b = this.s.currentBreak;
    if (!b) return 0;
    if (b.kind === "custom" || b.kind === "planned") return 0;
    switch (this.settings.disciplineLevel) {
      case "casual":
        return 0;
      case "balanced":
        return Math.max(0, this.settings.skipDelay - b.elapsed);
      case "hardcore":
        return Infinity;
    }
  }

  canSkip(): boolean {
    if (this.s.status === "break") return this.skipUnlocksIn() === 0;
    if (this.s.status !== "working") return false;
    return this.settings.disciplineLevel !== "hardcore" && this.s.advanceSkipsToday < this.settings.advanceSkipsPerDay;
  }

  canSnooze(): boolean {
    if (this.settings.disciplineLevel === "hardcore") return false;
    if (this.s.status !== "working" && this.s.status !== "break") return false;
    if (this.s.currentBreak && this.s.currentBreak.kind !== "short" && this.s.currentBreak.kind !== "long") return false;
    const { snoozeLimitPerBreak, snoozeLimitPerDay } = this.settings;
    if (snoozeLimitPerBreak > 0 && this.s.snoozesThisBreak >= snoozeLimitPerBreak) return false;
    if (snoozeLimitPerDay > 0 && this.s.snoozesToday >= snoozeLimitPerDay) return false;
    return true;
  }

  snapshot(): EngineSnapshot {
    const pause =
      this.s.status === "paused"
        ? this.s.manualPause
          ? { reason: "manual" as PauseReason, until: this.s.manualPause.until }
          : this.autoPause
            ? { reason: this.autoPause.reason, detail: this.autoPause.detail, until: null }
            : null
        : null;
    const unlock = this.skipUnlocksIn();
    return {
      status: this.s.status,
      workElapsed: this.s.workElapsed,
      workDuration: this.settings.workDuration,
      remaining: this.remaining,
      nextBreakIsLong: this.nextBreakIsLong,
      breaksTaken: this.s.breaksTaken,
      pause,
      currentBreak: this.s.currentBreak ? stripInternal(this.s.currentBreak) : null,
      snoozesThisBreak: this.s.snoozesThisBreak,
      snoozesToday: this.s.snoozesToday,
      skipsToday: this.s.skipsToday,
      advanceSkipsToday: this.s.advanceSkipsToday,
      canSkip: this.canSkip(),
      canSnooze: this.canSnooze(),
      skipUnlocksIn: Number.isFinite(unlock) ? unlock : -1,
    };
  }

  // ---------------------------------------------------------------- tick

  tick(now: number, ctx: TickContext): EngineEvent[] {
    const events: EngineEvent[] = [];
    const dt = this.lastTick == null ? 0 : Math.min(MAX_TICK_SEC, Math.max(0, (now - this.lastTick) / 1000));
    this.lastTick = now;

    const today = dayKey(now);
    if (today !== this.s.day) {
      this.s.day = today;
      this.s.snoozesToday = 0;
      this.s.skipsToday = 0;
      this.s.advanceSkipsToday = 0;
      events.push({ type: "day-rollover" });
    }

    if (this.s.status === "stopped") return events;

    if (this.s.status === "break") {
      this.tickBreak(dt, events);
      return events;
    }

    // Manual pause expiry.
    if (this.s.manualPause) {
      if (this.s.manualPause.until != null && now >= this.s.manualPause.until) {
        this.s.manualPause = null;
        this.s.status = "working";
        events.push({ type: "resumed", reason: "manual" });
      } else {
        this.s.status = "paused";
        return events;
      }
    }

    this.updateAutoPause(now, ctx, events);
    if (this.autoPause) {
      this.s.status = "paused";
      if (this.settings.remindersDuringPause && isSmartReason(this.autoPause.reason)) this.tickWellness(dt, events);
      this.checkPlanned(now, events, true);
      return events;
    }
    this.s.status = "working";

    this.s.workElapsed += dt;
    this.s.sessionElapsed += dt;
    if (dt > 0) events.push({ type: "focus-tick", seconds: dt });
    this.tickWellness(dt, events);

    if (this.checkPlanned(now, events, false)) return events;

    const remaining = this.remaining;
    if (this.settings.reminderEnabled && !this.headsUpShown && remaining <= this.settings.reminderThreshold && remaining > 0) {
      this.headsUpShown = true;
      events.push({ type: "heads-up", secondsLeft: remaining, isLong: this.nextBreakIsLong });
    }
    if (this.settings.countdownEnabled && !this.countdownShown && remaining <= this.settings.countdownThreshold && remaining > 0) {
      this.countdownShown = true;
      events.push({ type: "countdown", secondsLeft: remaining });
    }
    if (remaining <= 0 && now >= this.smartPauseCooldownUntil) {
      events.push(...this.startBreak(this.nextBreakIsLong ? "long" : "short", now));
    }
    return events;
  }

  private tickBreak(dt: number, events: EngineEvent[]): void {
    const b = this.s.currentBreak!;
    b.elapsed = Math.min(b.duration, b.elapsed + dt);
    if (b.elapsed >= b.duration) {
      if (this.settings.holdBreakUntilEnded) {
        if (!b.completeNotified) {
          b.completeNotified = true;
          events.push({ type: "break-complete", info: stripInternal(b) });
        }
      } else {
        events.push(...this.finishBreak("completed"));
      }
    }
  }

  private tickWellness(dt: number, events: EngineEvent[]): void {
    const st = this.settings;
    if (st.blinkReminderEnabled && st.blinkReminderFrequency > 0) {
      this.blinkElapsed += dt;
      if (this.blinkElapsed >= st.blinkReminderFrequency) {
        this.blinkElapsed = 0;
        events.push({ type: "wellness", kind: "blink" });
      }
    }
    if (st.postureReminderEnabled && st.postureReminderFrequency > 0) {
      this.postureElapsed += dt;
      if (this.postureElapsed >= st.postureReminderFrequency) {
        this.postureElapsed = 0;
        events.push({ type: "wellness", kind: "posture" });
      }
    }
  }

  private updateAutoPause(now: number, ctx: TickContext, events: EngineEvent[]): void {
    const st = this.settings;
    let reason: { reason: PauseReason; detail?: string } | null = null;
    let away = false;
    if (ctx.suspended) {
      reason = { reason: "suspended" };
      away = true;
    } else if (ctx.screenLocked) {
      reason = { reason: "screen-locked" };
      away = true;
    } else if (st.idlePauseEnabled && ctx.idleSec >= st.idleTimeForPause) {
      reason = { reason: "idle" };
      away = true;
    } else if (st.officeHoursEnabled && ctx.outsideOfficeHours) {
      reason = { reason: "office-hours" };
    } else if (ctx.smartPause) {
      reason = ctx.smartPause;
    }

    // Track time away from the computer for idle pause/reset decisions.
    if (away && this.awayStartedAt == null) {
      // Idle is detected after the fact: the user actually left idleSec ago.
      const idleBack = ctx.idleSec;
      this.awayStartedAt = now - idleBack * 1000;
      this.awayIdleCorrection = Math.min(this.s.workElapsed, idleBack);
      this.s.workElapsed -= this.awayIdleCorrection;
      this.s.sessionElapsed = Math.max(0, this.s.sessionElapsed - this.awayIdleCorrection);
    } else if (!away && this.awayStartedAt != null) {
      const awaySec = (now - this.awayStartedAt) / 1000;
      this.awayStartedAt = null;
      if (st.idleResetEnabled && awaySec >= st.idleTimeForReset) {
        this.lastReturn = { workElapsed: this.s.workElapsed, sessionElapsed: this.s.sessionElapsed };
        if (this.s.sessionElapsed > 0) events.push({ type: "session-end", lengthSec: this.s.sessionElapsed });
        this.resetCycle();
        events.push({ type: "returned", awaySec, mode: "reset" });
      } else {
        this.lastReturn = null;
        events.push({ type: "returned", awaySec, mode: "resume" });
      }
    }

    const prev = this.autoPause;
    if (reason && (!prev || prev.reason !== reason.reason || prev.detail !== reason.detail)) {
      events.push({ type: "paused", reason: reason.reason, detail: reason.detail });
    }
    if (!reason && prev) {
      events.push({ type: "resumed", reason: prev.reason });
      if (isSmartReason(prev.reason)) this.smartPauseCooldownUntil = now + st.smartPauseCooldown * 1000;
    }
    this.autoPause = reason;
  }

  /** Returns true if a planned break started. */
  private checkPlanned(now: number, events: EngineEvent[], queueOnly: boolean): boolean {
    const d = new Date(now);
    const weekday = d.getDay();
    const minutes = d.getHours() * 60 + d.getMinutes();
    const today = dayKey(now);
    for (const pb of this.settings.plannedBreaks) {
      if (!pb.enabled || !pb.days.includes(weekday as never)) continue;
      if (this.s.plannedFired[pb.id] === today) continue;
      const at = pb.time.hour * 60 + pb.time.minute;
      // Fire at the scheduled minute, or late if it was waiting on a smart pause (up to 2 h).
      if (minutes < at || minutes > at + 120) continue;
      if (queueOnly) continue;
      this.s.plannedFired[pb.id] = today;
      events.push(...this.startBreak("planned", now, pb.durationMin * 60, pb.id, pb.name));
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- commands

  startBreak(kind: BreakKind, now: number, durationSec?: number, plannedId?: string, plannedName?: string): EngineEvent[] {
    if (this.s.status === "break") return [];
    const events: EngineEvent[] = [];
    if (this.s.sessionElapsed > 0) events.push({ type: "session-end", lengthSec: this.s.sessionElapsed });
    const st = this.settings;
    const duration =
      durationSec ?? (kind === "long" ? st.longBreakDuration : kind === "short" ? st.shortBreakDuration : st.shortBreakDuration);
    const copy = breakCopy(
      kind,
      { customShortTitles: st.customShortTitles, customLongTitles: st.customLongTitles, plannedName },
      this.rand,
    );
    this.s.manualPause = null;
    this.s.status = "break";
    this.s.currentBreak = {
      kind,
      title: copy.title,
      message: copy.message,
      duration,
      elapsed: 0,
      startedAt: now,
      plannedId,
      completeNotified: false,
    };
    events.push({ type: "break-start", info: stripInternal(this.s.currentBreak) });
    return events;
  }

  /** User pressed Skip (during a break) or skip-in-advance (while working). */
  skip(): EngineEvent[] {
    if (!this.canSkip()) return [];
    if (this.s.status === "break") {
      this.s.skipsToday++;
      return this.finishBreak("skipped");
    }
    this.s.advanceSkipsToday++;
    this.s.breaksTaken++;
    this.resetCycle();
    return [{ type: "skipped-in-advance" }];
  }

  /** End a break early (allowed once complete, or within the last 10 seconds). */
  endBreak(): EngineEvent[] {
    const b = this.s.currentBreak;
    if (!b) return [];
    if (b.duration - b.elapsed > 10 && !(b.kind === "custom" || b.kind === "planned")) return this.skip();
    return this.finishBreak("completed");
  }

  snooze(seconds: number): EngineEvent[] {
    if (!this.canSnooze()) return [];
    const events: EngineEvent[] = [];
    this.s.snoozesThisBreak++;
    this.s.snoozesToday++;
    if (this.s.status === "break") {
      const b = this.s.currentBreak!;
      this.s.currentBreak = null;
      this.s.status = "working";
      events.push({ type: "break-end", info: stripInternal(b), result: "snoozed" });
      this.s.workElapsed = Math.max(0, this.settings.workDuration - seconds);
    } else {
      this.s.workElapsed = Math.max(0, Math.min(this.s.workElapsed, this.settings.workDuration) - seconds);
    }
    this.headsUpShown = false;
    this.countdownShown = false;
    events.push({ type: "snoozed", seconds });
    return events;
  }

  pause(now: number, seconds: number | null): EngineEvent[] {
    if (this.s.status === "stopped" || this.s.status === "break") return [];
    this.s.manualPause = { until: seconds == null ? null : now + seconds * 1000 };
    this.s.status = "paused";
    return [{ type: "paused", reason: "manual" }];
  }

  resume(): EngineEvent[] {
    if (this.s.status === "stopped") {
      this.s.status = "working";
      return [{ type: "resumed", reason: "manual" }];
    }
    if (!this.s.manualPause) return [];
    this.s.manualPause = null;
    this.s.status = "working";
    return [{ type: "resumed", reason: "manual" }];
  }

  /** Reset timers and long-break cycle. */
  restart(): EngineEvent[] {
    const events: EngineEvent[] = [];
    if (this.s.sessionElapsed > 0) events.push({ type: "session-end", lengthSec: this.s.sessionElapsed });
    if (this.s.currentBreak) {
      events.push({ type: "break-end", info: stripInternal(this.s.currentBreak), result: "skipped" });
      this.s.currentBreak = null;
    }
    this.s.breaksTaken = 0;
    this.s.manualPause = null;
    this.s.status = "working";
    this.resetCycle();
    return events;
  }

  stop(): EngineEvent[] {
    const events = this.restart();
    this.s.status = "stopped";
    return events;
  }

  /** Flip the most recent idle-return decision (reset <-> resume). */
  undoReturnReset(): boolean {
    if (!this.lastReturn) return false;
    this.s.workElapsed = this.lastReturn.workElapsed;
    this.s.sessionElapsed = this.lastReturn.sessionElapsed;
    this.lastReturn = null;
    return true;
  }

  // ---------------------------------------------------------------- internals

  private finishBreak(result: "completed" | "skipped"): EngineEvent[] {
    const b = this.s.currentBreak;
    if (!b) return [];
    this.s.currentBreak = null;
    this.s.status = "working";
    if (b.kind === "short" || b.kind === "long") this.s.breaksTaken++;
    this.resetCycle();
    return [{ type: "break-end", info: stripInternal(b), result }];
  }

  private resetCycle(): void {
    this.s.workElapsed = 0;
    this.s.sessionElapsed = 0;
    this.s.snoozesThisBreak = 0;
    this.headsUpShown = false;
    this.countdownShown = false;
    this.blinkElapsed = 0;
    this.postureElapsed = 0;
  }
}

function isSmartReason(r: PauseReason): boolean {
  return r === "deep-focus" || r === "meeting" || r === "fullscreen";
}

function stripInternal(b: BreakInfo & { completeNotified?: boolean }): BreakInfo {
  const { completeNotified: _ignored, ...rest } = b;
  return rest;
}
