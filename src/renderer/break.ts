import { formatClock } from "../shared/messages";
import type { EngineSnapshot, Settings } from "../shared/types";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, el, gradientCss, param } from "./api";

const CIRC = 2 * Math.PI * 100;
const primary = param<boolean>("primary") === true;
if (!primary) document.body.classList.add("secondary");

const $ = (id: string) => document.getElementById(id)!;
let settings: Settings;
let lastEsc = 0;
let lastActionsKey = "";

function applyLook(s: Settings): void {
  document.body.classList.toggle("blur", s.breakBackground === "blur");
  document.body.classList.toggle("image", s.breakBackground === "image" && !!s.backgroundImage);
  const bg = $("bg");
  if (s.breakBackground === "image" && s.backgroundImage) {
    // Served through Tauri's asset protocol (the backend allows exactly this file).
    bg.style.backgroundImage = `url("${convertFileSrc(s.backgroundImage)}")`;
  } else {
    bg.style.backgroundImage = gradientCss(s.gradient);
  }
  $("clock").style.display = s.showClock ? "" : "none";
  $("title").style.display = s.hideTitle ? "none" : "";
  $("message").style.display = s.hideSubtitle ? "none" : "";
}

function renderActions(snap: EngineSnapshot): void {
  const b = snap.currentBreak!;
  const complete = b.elapsed >= b.duration;
  const key = [snap.canSkip, snap.canSnooze, complete, snap.skipUnlocksIn > 0 ? Math.ceil(snap.skipUnlocksIn) : 0].join("|");
  if (key === lastActionsKey) return;
  lastActionsKey = key;

  const actions = $("actions");
  actions.replaceChildren();
  if (complete && settings.holdBreakUntilEnded) {
    actions.append(el("button", { class: "primary", textContent: "End break", onclick: () => api.cmd("endBreak") }));
    $("hint").textContent = "Break complete — press End break when you're ready.";
    return;
  }
  if (snap.canSnooze) {
    for (const [label, sec] of [["+1 min", 60], ["+5 min", 300]] as const) {
      actions.append(el("button", { textContent: label, onclick: () => api.cmd("snooze", sec) }));
    }
  }
  if (b.kind === "custom" || b.kind === "planned") {
    actions.append(el("button", { textContent: "End break", onclick: () => api.cmd("endBreak") }));
  } else if (snap.canSkip) {
    actions.append(el("button", { textContent: "Skip break", onclick: () => api.cmd("skip") }));
  } else if (snap.skipUnlocksIn > 0) {
    actions.append(el("button", { textContent: `Skip in ${Math.ceil(snap.skipUnlocksIn)}s`, disabled: true }));
  }

  const escTarget = settings.escapeAction === "skip" && snap.canSkip ? "skip" : settings.escapeAction === "snooze" && snap.canSnooze ? "snooze 1 minute" : null;
  $("hint").textContent =
    settings.disciplineLevel === "hardcore" && b.kind !== "custom" && b.kind !== "planned"
      ? "Hardcore mode — this break can't be skipped."
      : escTarget
        ? `Press Esc twice to ${escTarget}`
        : "";
}

function render(snap: EngineSnapshot): void {
  const b = snap.currentBreak;
  if (!b || !settings) return;
  const left = Math.max(0, b.duration - b.elapsed);
  $("time").textContent = formatClock(left);
  ($("progress") as unknown as SVGCircleElement).style.strokeDashoffset = String(CIRC * (b.elapsed / b.duration));
  if ($("title").textContent !== b.title) $("title").textContent = b.title;
  if ($("message").textContent !== b.message) $("message").textContent = b.message;
  document.body.classList.toggle("complete", left <= 0);
  $("clock").textContent = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (primary) renderActions(snap);
}

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !primary) return;
  const now = Date.now();
  if (now - lastEsc < 1200) {
    if (settings.escapeAction === "skip") void api.cmd("skip");
    else if (settings.escapeAction === "snooze") void api.cmd("snooze", 60);
    lastEsc = 0;
  } else lastEsc = now;
});

(async () => {
  settings = await api.settings();
  applyLook(settings);
  render(await api.state());
  api.onState(render);
  api.onSettings((s) => {
    settings = s;
    applyLook(s);
    lastActionsKey = "";
  });
})();
