// Break-screen copy. Original text written for FarSight.
import type { BreakKind } from "./types";

const SHORT_TITLES = [
  "Eyes on the horizon",
  "Rest your eyes",
  "A short pause",
  "Look somewhere far",
  "Blink and breathe",
];

const SHORT_MESSAGES = [
  "Pick something at least six metres away and let your focus soften.",
  "Let your eyes drift to the farthest point you can see.",
  "Relax your shoulders, unclench your jaw, and look into the distance.",
  "Gaze out of a window or across the room until the timer ends.",
];

const LONG_TITLES = ["Time for a real break", "Step away for a bit", "Stretch it out", "Recharge"];

const LONG_MESSAGES = [
  "Stand up, walk around and give your eyes and back a proper rest.",
  "Grab some water, stretch your legs and come back refreshed.",
  "Move your body. Your next focus session will thank you.",
];

const CUSTOM_TITLES = ["Your break", "Time for yourself"];
const CUSTOM_MESSAGES = ["You asked for this break. Enjoy every second of it."];

const PLANNED_MESSAGES = ["You scheduled this one. Make the most of it."];

const pick = <T>(list: T[], rand: () => number): T => list[Math.floor(rand() * list.length) % list.length];

export function breakCopy(
  kind: BreakKind,
  opts: { customShortTitles?: string[]; customLongTitles?: string[]; plannedName?: string },
  rand: () => number = Math.random,
): { title: string; message: string } {
  switch (kind) {
    case "short": {
      const titles = opts.customShortTitles?.length ? opts.customShortTitles : SHORT_TITLES;
      return { title: pick(titles, rand), message: pick(SHORT_MESSAGES, rand) };
    }
    case "long": {
      const titles = opts.customLongTitles?.length ? opts.customLongTitles : LONG_TITLES;
      return { title: pick(titles, rand), message: pick(LONG_MESSAGES, rand) };
    }
    case "planned":
      return { title: opts.plannedName || "Planned break", message: pick(PLANNED_MESSAGES, rand) };
    case "custom":
      return { title: pick(CUSTOM_TITLES, rand), message: pick(CUSTOM_MESSAGES, rand) };
  }
}

export function formatDuration(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return m > 0 ? `${h} hr ${m} min` : `${h} hr`;
  if (m > 0) return sec > 0 && m < 5 ? `${m} min ${sec} sec` : `${m} min`;
  return `${sec} sec`;
}

export function formatClock(totalSec: number): string {
  const s = Math.max(0, Math.ceil(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  const ss = String(sec).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
