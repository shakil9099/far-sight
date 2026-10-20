import { formatClock, formatDuration } from "../shared/messages";
import type { EngineSnapshot } from "../shared/types";
import { api, el } from "./api";
import { ICONS, icon, type IconName } from "./icons";

const params = new URLSearchParams(location.search);
const kind = params.get("kind") ?? "info";
const payload = JSON.parse(params.get("payload") ?? "{}");
const card = document.getElementById("card")!;
const close = () => api.cmd("closeToast", kind);

function head(tile: string, iconName: IconName, title: string, sub: string, numericTitle = false): HTMLElement {
  const t = el("div", { class: numericTitle ? "title num" : "title", textContent: title });
  t.id = "title";
  const s = el("div", { class: "sub", textContent: sub });
  s.id = "sub";
  return el("div", { class: "head" }, icon(iconName, tile, "lg"), el("div", { class: "text" }, t, s));
}

function closeButton(): HTMLElement {
  const b = el("button", { class: "plain x", title: "Dismiss", onclick: close });
  b.innerHTML = ICONS.close;
  return b;
}

async function headsUp(): Promise<void> {
  const snap = await api.state();
  const clock = (s: number) => formatClock(s).padStart(5, "0");
  card.append(
    closeButton(),
    head(
      "sunset",
      "hourglass",
      clock(snap.remaining),
      payload.isLong ? "A longer break is next. Time to stand up soon." : "Get ready to rest your eyes for a moment.",
      true,
    ),
    el(
      "div",
      { class: "actions" },
      el("button", { class: "primary", textContent: "Start break now", onclick: () => api.cmd("startBreak", payload.isLong ? "long" : "short") }),
      ...[60, 300, 900].map((s) => el("button", { textContent: `+${s / 60}m`, disabled: !snap.canSnooze, onclick: () => api.cmd("snooze", s) })),
    ),
  );
  api.onState((s: EngineSnapshot) => {
    if (s.status !== "working") return void close();
    document.getElementById("title")!.textContent = clock(s.remaining);
  });
}

function returned(): void {
  const away = formatDuration(payload.awaySec);
  const reset = payload.mode === "reset";
  card.append(
    closeButton(),
    head(
      reset ? "mint" : "sky",
      reset ? "leaf" : "play",
      reset ? "Fresh session started" : "Welcome back",
      reset ? `You were away for ${away}. That counted as a break.` : `You were away for ${away}. Your session continues.`,
    ),
  );
  if (reset) card.append(el("div", { class: "actions" }, el("button", { textContent: "Undo — keep my session", onclick: () => api.cmd("undoReturn") })));
}

const PAUSE: Record<string, [string, IconName, string]> = {
  meeting: ["sky", "call", "On a call"],
  "deep-focus": ["gold", "target", "Deep focus"],
  fullscreen: ["pink", "screen", "Fullscreen app"],
};

function paused(): void {
  const [tile, ic, title] = PAUSE[payload.reason] ?? ["grey", "pause", "Paused"];
  card.append(head(tile, ic, title, `${payload.detail && payload.detail !== "Microphone" ? `${payload.detail} is active. ` : ""}Breaks will wait until you're done.`));
}

function pill(tile: string, ic: IconName, text: string): void {
  document.body.classList.add("pill");
  card.append(icon(ic, tile), el("div", { class: "title", textContent: text }));
}

switch (kind) {
  case "heads-up":
    void headsUp();
    break;
  case "returned":
    returned();
    break;
  case "paused":
    paused();
    break;
  case "wellness":
    payload.kind === "blink" ? pill("sky", "eye", "Blink slowly a few times") : pill("mint", "posture", "Sit tall, relax your shoulders");
    break;
  case "notice":
    document.body.classList.add("notice");
    pill("grey", (payload.icon as IconName) ?? "info", payload.text ?? "");
    break;
  default:
    card.append(head("grey", "info", payload.title ?? "FarSight", payload.message ?? ""));
}
