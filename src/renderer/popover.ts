import { formatClock, formatDuration } from "../shared/messages";
import type { EngineSnapshot, Settings, StatsSummary } from "../shared/types";
import { api, bridge, el } from "./api";
import { gauge } from "./gauge";
import { ICONS, icon, type IconName } from "./icons";

document.body.classList.add(bridge.platform === "darwin" ? "mac" : "win");
const view = document.getElementById("view")!;
let tab: "now" | "stats" = "now";
let settings: Settings;
let snap: EngineSnapshot;
let builtFor = "";

document.getElementById("btn-settings")!.innerHTML = ICONS.gear;
document.getElementById("btn-calendar")!.innerHTML = ICONS.calendar;
document.getElementById("btn-settings")!.onclick = () => bridge.cmd("openSettings");
document.getElementById("btn-calendar")!.onclick = () => bridge.cmd("openSettings", "stats");
for (const b of document.querySelectorAll<HTMLButtonElement>("#tabs button")) {
  b.onclick = () => {
    tab = b.dataset.tab as "now" | "stats";
    document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
    builtFor = "";
    void render();
  };
}

const PAUSE_LABEL: Record<string, string> = {
  manual: "Paused",
  idle: "Paused while you're away",
  "screen-locked": "Paused · screen locked",
  "deep-focus": "Paused for focus",
  meeting: "Paused for your call",
  fullscreen: "Paused · fullscreen app",
  video: "Paused · video playing",
  "office-hours": "Outside office hours",
  suspended: "Paused",
};

const mins = (sec: number) => {
  const m = Math.floor(sec / 60);
  return m < 1 ? "< 1 min" : `${m} min${m === 1 ? "" : "s"}`;
};
const secsLabel = (sec: number) => (sec < 60 ? `${sec} secs` : formatDuration(sec));

function row(tile: string, iconName: IconName, label: string, value: Node | string, id?: string): HTMLElement {
  const v = typeof value === "string" ? el("span", { class: "value", textContent: value }) : value;
  if (id) (v as HTMLElement).id = id;
  return el("div", { class: "item" }, icon(iconName, tile), el("span", { class: "grow", textContent: label }), v);
}

function footerBtn(iconName: IconName, label: string, onclick: () => void, disabled = false): HTMLButtonElement {
  const b = el("button", { onclick, disabled });
  b.innerHTML = ICONS[iconName];
  b.append(label);
  return b;
}

// ------------------------------------------------------------------ Now

function nowKey(): string {
  return [snap.status, snap.pause?.reason, snap.canSnooze, snap.canSkip, snap.currentBreak?.kind, snap.nextBreakIsLong].join("|");
}

function buildNow(): void {
  const parts: Node[] = [];
  const hero = el("div", { class: "hero" });
  const glyph = el("span", { class: "glyph" });
  const caption = el("div", { class: "caption", id: "caption" });
  const big = el("div", { class: "big num", id: "big" });
  const detail = el("div", { class: "detail", id: "detail" });
  const pills = el("div", { class: "pills" });

  switch (snap.status) {
    case "working":
      glyph.innerHTML = ICONS.hourglass;
      caption.textContent = snap.nextBreakIsLong ? "Long break starts in" : "Break starts in";
      pills.append(
        el("button", { class: "primary", textContent: "Start break now", onclick: () => bridge.cmd("startBreak", snap.nextBreakIsLong ? "long" : "short") }),
        ...[60, 300, 900].map((s) => el("button", { textContent: `+${s / 60}m`, disabled: !snap.canSnooze, onclick: () => bridge.cmd("snooze", s) })),
      );
      break;
    case "paused":
      hero.classList.add("paused");
      glyph.innerHTML = ICONS.pause;
      caption.textContent = PAUSE_LABEL[snap.pause?.reason ?? "manual"];
      pills.append(
        snap.pause?.reason === "manual"
          ? el("button", { class: "primary", textContent: "Resume", onclick: () => bridge.cmd("resume") })
          : el("button", { class: "primary", textContent: "Start break now", onclick: () => bridge.cmd("startBreak", "short") }),
      );
      break;
    case "break":
      hero.classList.add("break");
      glyph.innerHTML = ICONS.leaf;
      caption.textContent = "On a break";
      pills.append(
        snap.currentBreak?.kind === "custom" || snap.currentBreak?.kind === "planned"
          ? el("button", { class: "primary", textContent: "End break", onclick: () => bridge.cmd("endBreak") })
          : el("button", { class: "primary", textContent: "Skip break", disabled: !snap.canSkip, onclick: () => bridge.cmd("skip") }),
      );
      break;
    case "stopped":
      hero.classList.add("paused");
      glyph.innerHTML = ICONS.eye;
      caption.textContent = "FarSight is off";
      pills.append(el("button", { class: "primary", textContent: "Start FarSight", onclick: () => bridge.cmd("start") }));
      break;
  }
  hero.append(glyph, caption, big, detail);
  parts.push(hero, pills);

  const kind = snap.nextBreakIsLong ? "Long" : "Short";
  const len = snap.nextBreakIsLong ? settings.longBreakDuration : settings.shortBreakDuration;
  const upcoming = el(
    "span",
    { class: "value" },
    kind,
    el("span", { class: "dot", textContent: "•" }),
    secsLabel(len),
  );
  parts.push(
    el(
      "div",
      { class: "rows" },
      row("gold", "bolt", "Current focus time", "", "focus-value"),
      row("pink", "leaf", "Upcoming break", upcoming),
      row("sky", "check", "Breaks today", "", "breaks-value"),
    ),
  );

  const paused = snap.status === "paused" && snap.pause?.reason === "manual";
  parts.push(
    el(
      "div",
      { class: "footer" },
      paused
        ? footerBtn("play", "Resume", () => bridge.cmd("resume"))
        : footerBtn("pause", "Pause", () => bridge.cmd("popupPauseMenu"), snap.status === "stopped" || snap.status === "break"),
      footerBtn("skip", "Skip next", () => bridge.cmd("skip"), !(snap.status === "working" && snap.canSkip)),
      footerBtn("restart", "Restart", () => bridge.cmd("restart"), snap.status === "stopped"),
      footerBtn("sun", "Custom", () => bridge.cmd("popupCustomMenu"), snap.status === "break" || snap.status === "stopped"),
    ),
  );
  view.replaceChildren(...parts);
}

async function updateNow(): Promise<void> {
  const big = document.getElementById("big");
  const detail = document.getElementById("detail");
  if (!big || !detail) return;
  if (snap.status === "working") {
    big.textContent = formatClock(snap.remaining).padStart(5, "0");
    detail.textContent = snap.snoozesThisBreak ? `Snoozed ${snap.snoozesThisBreak}×` : "";
  } else if (snap.status === "break" && snap.currentBreak) {
    big.textContent = formatClock(snap.currentBreak.duration - snap.currentBreak.elapsed).padStart(5, "0");
    detail.textContent = snap.currentBreak.title;
  } else if (snap.status === "paused") {
    big.textContent = formatClock(snap.remaining).padStart(5, "0");
    const p = snap.pause;
    detail.textContent = p?.until ? `Resumes in ${formatDuration((p.until - Date.now()) / 1000)}` : p?.detail ?? "Timer is on hold";
  } else {
    big.textContent = "--:--";
    detail.textContent = "No breaks will be shown";
  }
  document.getElementById("focus-value")!.textContent = mins(snap.workElapsed);
  const st: StatsSummary = await api.stats();
  const b = document.getElementById("breaks-value");
  if (b) b.textContent = `${st.today.breaksTaken + st.today.naturalBreaks} taken`;
}

// ------------------------------------------------------------------ Stats

async function buildStats(): Promise<void> {
  const st: StatsSummary = await api.stats();
  const title = el(
    "div",
    { class: "score-title" },
    el("button", { class: "plain", disabled: true }),
    el("span", { textContent: "Today's Screen Score" }),
    el("button", { class: "plain", disabled: true }),
  );
  (title.firstChild as HTMLElement).innerHTML = ICONS.chevronL;
  (title.lastChild as HTMLElement).innerHTML = ICONS.chevronR;

  const legend = el("div", { class: "legend" });
  const p = st.parts;
  if (!p) {
    legend.append(el("div", { class: "empty", textContent: "Not enough screen time yet to score today." }));
  } else {
    const t = st.today;
    const line = (color: string, text: string, pts: number) =>
      el("div", { class: "l" }, el("span", { class: "swatch", style: `background:${color}` }), el("span", { textContent: text }), el("span", { class: "pts", textContent: String(pts) }));
    legend.append(
      line("linear-gradient(160deg,#ff7ae6,#b44bd9)", t.breaksSkipped ? `Skipped ${t.breaksSkipped} break${t.breaksSkipped === 1 ? "" : "s"}` : "Breaks taken on time", p.disciplinePenalty),
      line("linear-gradient(160deg,#f2c94c,#b8860b)", t.longestSessionSec ? `Spent ${mins(t.longestSessionSec).replace(" mins", "m").replace(" min", "m")} without a break` : "Short, healthy sessions", p.pacingPenalty),
    );
  }

  view.replaceChildren(
    title,
    el("div", { class: "gauge" }, gauge(st, 236)),
    legend,
    el(
      "div",
      { class: "rows" },
      row("sky", "screen", "Screen time", formatDuration(st.today.screenTimeSec)),
      row("pink", "play", "Video watched", st.today.videoSec >= 1 ? formatDuration(st.today.videoSec) : "None"),
      row("mint", "check", "Breaks taken", String(st.today.breaksTaken + st.today.naturalBreaks)),
    ),
  );
}

// ------------------------------------------------------------------ main

async function render(): Promise<void> {
  if (tab === "stats") {
    if (builtFor !== "stats") {
      builtFor = "stats";
      await buildStats();
    }
    return;
  }
  const key = nowKey();
  if (key !== builtFor) {
    builtFor = key;
    buildNow();
  }
  await updateNow();
}

(async () => {
  settings = await api.settings();
  snap = await api.state();
  await render();
  api.onState((s) => {
    snap = s;
    void render();
  });
  api.onSettings((s) => {
    settings = s;
    builtFor = "";
  });
  bridge.on("open-tab", (t: string) => {
    if (t === "now" || t === "stats") document.querySelector<HTMLButtonElement>(`#tabs button[data-tab="${t}"]`)?.click();
  });
})();
