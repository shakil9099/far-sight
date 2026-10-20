// Daily usage statistics and the Screen Score (0-100).
import type { DayStats, StatsSummary } from "./types";
import { dayKey } from "./engine";

export function emptyDay(date: string): DayStats {
  return {
    date,
    screenTimeSec: 0,
    breaksTaken: 0,
    breaksSkipped: 0,
    naturalBreaks: 0,
    snoozes: 0,
    sessions: [],
    longestSessionSec: 0,
    hourly: new Array(24).fill(0),
  };
}

/**
 * Screen Score: rewards short focus sessions and consistently taken breaks.
 *  - 60% session pacing: each session scores 1 when at or below the target length,
 *    falling off proportionally beyond it; averaged weighted by session length.
 *  - 40% break discipline: taken (and natural) breaks vs skipped, with snoozes as a partial miss.
 * Returns null until there are 15 minutes of screen time.
 */
export function screenScore(day: DayStats, targetSessionSec: number): number | null {
  return scoreParts(day, targetSessionSec)?.score ?? null;
}

export interface ScoreParts {
  score: number;
  /** 0..1 — how well session lengths stayed within the target. */
  pacing: number;
  /** 0..1 — taken vs skipped/snoozed breaks. */
  discipline: number;
  /** Points lost to long sessions (max 60). */
  pacingPenalty: number;
  /** Points lost to skips and snoozes (max 40). */
  disciplinePenalty: number;
}

export function scoreParts(day: DayStats, targetSessionSec: number): ScoreParts | null {
  if (day.screenTimeSec < 15 * 60) return null;
  const sessions = day.sessions.filter((s) => s >= 60);
  let pacing = 1;
  if (sessions.length) {
    let weighted = 0;
    let total = 0;
    for (const len of sessions) {
      const q = len <= targetSessionSec ? 1 : Math.max(0, targetSessionSec / len);
      weighted += q * len;
      total += len;
    }
    pacing = weighted / total;
  }
  const good = day.breaksTaken + day.naturalBreaks;
  const bad = day.breaksSkipped + day.snoozes * 0.25;
  const discipline = good + bad === 0 ? 1 : good / (good + bad);
  const pacingPenalty = Math.round(60 * (1 - pacing));
  const disciplinePenalty = Math.round(40 * (1 - discipline));
  return { score: Math.round(100 * (0.6 * pacing + 0.4 * discipline)), pacing, discipline, pacingPenalty, disciplinePenalty };
}

export class StatsBook {
  days: Record<string, DayStats>;

  constructor(stored?: Record<string, DayStats> | null) {
    this.days = stored ?? {};
  }

  day(now: number): DayStats {
    const key = dayKey(now);
    return (this.days[key] ??= emptyDay(key));
  }

  addFocus(now: number, seconds: number): void {
    const d = this.day(now);
    d.screenTimeSec += seconds;
    d.hourly[new Date(now).getHours()] += seconds;
  }

  endSession(now: number, lengthSec: number): void {
    if (lengthSec < 30) return;
    const d = this.day(now);
    d.sessions.push(Math.round(lengthSec));
    d.longestSessionSec = Math.max(d.longestSessionSec, Math.round(lengthSec));
  }

  breakTaken(now: number): void {
    this.day(now).breaksTaken++;
  }
  breakSkipped(now: number): void {
    this.day(now).breaksSkipped++;
  }
  naturalBreak(now: number): void {
    this.day(now).naturalBreaks++;
  }
  snoozed(now: number): void {
    this.day(now).snoozes++;
  }

  /** Drop days older than `keepDays`. */
  prune(now: number, keepDays = 90): void {
    const cutoff = dayKey(now - keepDays * 86400_000);
    for (const k of Object.keys(this.days)) if (k < cutoff) delete this.days[k];
  }

  summary(now: number, targetSessionSec: number): StatsSummary {
    const today = this.day(now);
    const history = [];
    for (let i = 6; i >= 0; i--) {
      const key = dayKey(now - i * 86400_000);
      const d = this.days[key] ?? emptyDay(key);
      history.push({ date: key, score: screenScore(d, targetSessionSec), screenTimeSec: d.screenTimeSec });
    }
    return { today, score: screenScore(today, targetSessionSec), parts: scoreParts(today, targetSessionSec), history };
  }
}
