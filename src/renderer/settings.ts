import { OPTIONS } from "../shared/defaults";
import { formatClock, formatDuration } from "../shared/messages";
import type { Automation, EngineSnapshot, PlannedBreak, Settings, StatsSummary, Weekday } from "../shared/types";
import { api, bridge, el, GRADIENTS, gradientCss, param } from "./api";
import { gauge } from "./gauge";
import { icon, type IconName } from "./icons";

type Key = keyof Settings;
let s: Settings;
let current = param<string>("tab") ?? "general";
const content = document.getElementById("content")!;
const isMac = bridge.platform === "darwin";
document.body.classList.add(isMac ? "mac" : "win");

const TABS: [string, IconName, string, string][] = [
  ["welcome", "sparkle", "sunset", "Welcome"],
  ["general", "gear", "grey", "General"],
  ["breaks", "hourglass", "sunset", "Breaks"],
  ["smart-pause", "pause", "sky", "Smart Pause"],
  ["wellness", "eye", "mint", "Wellness"],
  ["appearance", "palette", "pink", "Break Screen"],
  ["schedule", "calendar", "sky", "Schedule"],
  ["stats", "chart", "gold", "Stats"],
  ["automation", "bolt", "gold", "Automation"],
  ["about", "info", "grey", "About"],
];

// ------------------------------------------------------------------ controls

async function save(patch: Partial<Settings>): Promise<void> {
  s = await api.setSettings(patch);
}

function row(label: string, desc: string | null, control: Node | null): HTMLElement {
  return el(
    "div",
    { class: "row" },
    el("div", { class: "text" }, el("div", { class: "label", textContent: label }), desc ? el("div", { class: "desc", textContent: desc }) : null),
    control,
  );
}

function toggle(key: Key, onChange?: () => void): HTMLElement {
  const input = el("input", { type: "checkbox", checked: Boolean(s[key]) });
  input.onchange = async () => {
    await save({ [key]: input.checked } as Partial<Settings>);
    onChange?.();
  };
  return el("label", { class: "switch" }, input, el("span"));
}

function select<T extends string | number>(key: Key, options: T[], fmt: (v: T) => string, onChange?: () => void): HTMLSelectElement {
  const sel = el("select");
  const value = s[key] as unknown as T;
  const opts = options.includes(value) ? options : [...options, value].sort((a, b) => (a > b ? 1 : -1));
  for (const o of opts) sel.append(el("option", { value: String(o), textContent: fmt(o), selected: o === value }));
  sel.onchange = async () => {
    const raw = sel.value;
    const v = typeof value === "number" ? Number(raw) : raw;
    await save({ [key]: v } as Partial<Settings>);
    onChange?.();
  };
  return sel;
}

function seg<T extends string | boolean>(key: Key, options: [T, string][], onChange?: () => void): HTMLElement {
  const wrap = el("div", { class: "seg" });
  for (const [v, label] of options) {
    wrap.append(
      el("button", {
        textContent: label,
        className: s[key] === v ? "on" : "",
        onclick: async () => {
          await save({ [key]: v } as Partial<Settings>);
          onChange ? onChange() : render();
        },
      }),
    );
  }
  return wrap;
}

function slider(key: Key): HTMLInputElement {
  const r = el("input", { type: "range", min: "0", max: "1", step: "0.05", value: String(s[key]) });
  r.onchange = () => save({ [key]: Number(r.value) } as Partial<Settings>);
  return r;
}

const group = (...rows: (Node | null | false)[]) => el("div", { class: "group" }, ...rows);
const h3 = (t: string) => el("h3", { textContent: t });
const header = (title: string, lead: string) => [el("h2", { textContent: title }), el("p", { class: "lead", textContent: lead })];
const secs = (v: number) => formatDuration(v);

function appList(key: "deepFocusApps" | "meetingApps" | "videoExcludedApps", placeholder: string): HTMLElement {
  const list = s[key];
  const chips = el("div", { class: "chips" });
  if (!list.length) chips.append(el("span", { class: "empty", style: "padding:0", textContent: "No apps yet" }));
  for (const name of list) {
    chips.append(
      el(
        "span",
        { class: "chip" },
        name,
        el("button", { textContent: "×", title: `Remove ${name}`, onclick: async () => (await save({ [key]: list.filter((n) => n !== name) }), render()) }),
      ),
    );
  }
  const input = el("input", { type: "text", placeholder });
  const pick = el("select", { style: "min-width:160px" });
  pick.append(el("option", { value: "", textContent: "Running apps…" }));
  void bridge.cmd("listApps").then((apps: string[]) => {
    for (const a of apps) if (!list.includes(a)) pick.append(el("option", { value: a, textContent: a }));
  });
  const add = async (name: string) => {
    name = name.trim();
    if (!name || list.includes(name)) return;
    if (/farsight/i.test(name)) return alert("FarSight can't pause for itself — nice try!");
    await save({ [key]: [...list, name] });
    render();
  };
  pick.onchange = () => add(pick.value);
  input.onkeydown = (e) => e.key === "Enter" && add(input.value);
  return el(
    "div",
    {},
    chips,
    el("div", { class: "row" }, input, el("button", { textContent: "Add", onclick: () => add(input.value) }), pick),
  );
}

// ------------------------------------------------------------------ tabs

function welcome(): Node[] {
  return [
    el(
      "div",
      { class: "welcome" },
      el("div", { class: "hero", style: `background:${gradientCss(0)}`, textContent: "Look far. Feel better." }),
      el("h2", { textContent: "Welcome to FarSight" }),
      el("p", {
        class: "lead",
        textContent: "FarSight lives in your menu bar (or system tray on Windows) and reminds you to rest your eyes with the 20-20-20 rule: every 20 minutes, look about 20 feet away for 20 seconds.",
      }),
      el(
        "ol",
        {},
        el("li", { textContent: "A heads-up appears a minute before each break — snooze or start it right away." }),
        el("li", { textContent: "A small countdown follows your cursor for the last few seconds." }),
        el("li", { textContent: "Breaks cover every screen. Every few breaks, a longer one reminds you to stand up." }),
        el("li", { textContent: "Breaks pause automatically when you step away, lock your screen, or join a meeting." }),
      ),
      el(
        "div",
        { class: "btn-row" },
        el("button", { class: "primary", textContent: "Try a break now", onclick: () => bridge.cmd("startBreak", "short", 10) }),
        el("button", { textContent: "Customize timers", onclick: () => go("breaks") }),
        el("button", {
          textContent: "Done",
          onclick: async () => {
            await save({ hasCompletedOnboarding: true });
            go("general");
          },
        }),
      ),
    ),
  ];
}

function general(): Node[] {
  return [
    ...header("General", "Core behaviour and system integration."),
    group(
      row("Launch at login", "Start FarSight automatically when you sign in.", toggle("launchAtLogin")),
      isMac
        ? row(
            "Menu bar",
            "What to show next to the menu bar icon.",
            seg("menuBarDisplay", [
              ["icon", "Icon"],
              ["icon-and-text", "Icon + timer"],
            ]),
          )
        : null,
      row("Track screen-time stats", "Stored locally on this computer only.", toggle("statsEnabled")),
    ),
    h3("Keyboard shortcuts"),
    group(
      ...(
        [
          ["startBreak", "Start a break now"],
          ["togglePause", "Pause / resume"],
          ["snooze", "Snooze 5 minutes"],
          ["skip", "Skip break"],
        ] as const
      ).map(([k, label]) => {
        const input = el("input", { type: "text", value: s.shortcuts[k], className: "mono", style: "min-width:220px" });
        input.onchange = () => save({ shortcuts: { ...s.shortcuts, [k]: input.value.trim() } });
        return row(label, null, input);
      }),
    ),
    el("p", { class: "note", textContent: "Shortcuts use Electron accelerator syntax, e.g. CommandOrControl+Alt+B. Leave empty to disable." }),
    h3("Reset"),
    group(
      row(
        "Restore default settings",
        "Your stats are kept.",
        el("button", { textContent: "Restore defaults", onclick: async () => confirm("Restore all settings to their defaults?") && ((s = await bridge.cmd("resetSettings")), render()) }),
      ),
    ),
  ];
}

function breaks(): Node[] {
  const min = (v: number) => `${v / 60} min`;
  return [
    ...header("Breaks", "How long you focus and how long you rest."),
    group(
      row("Time between breaks", "Focused screen time before a break starts.", select("workDuration", OPTIONS.workDuration, min)),
      row("Short break length", "Look into the distance until the timer ends.", select("shortBreakDuration", OPTIONS.shortBreakDuration, secs)),
    ),
    h3("Long breaks"),
    group(
      row("Enable long breaks", "A longer break to stand up and stretch.", toggle("longBreakEnabled", render)),
      s.longBreakEnabled && row("Long break length", null, select("longBreakDuration", OPTIONS.longBreakDuration, min)),
      s.longBreakEnabled && row("Frequency", "Which break becomes a long break.", select("longBreakEvery", OPTIONS.longBreakEvery, (n) => `Every ${n}${ordinal(n)} break`)),
    ),
    h3("Before a break"),
    group(
      row("Heads-up notice", "A card with snooze and start-now options.", toggle("reminderEnabled", render)),
      s.reminderEnabled && row("Show heads-up", null, select("reminderThreshold", OPTIONS.reminderThreshold.filter(Boolean), (v) => `${secs(v)} before`)),
      row("Cursor countdown", "A small timer follows your pointer just before a break.", toggle("countdownEnabled", render)),
      s.countdownEnabled && row("Countdown length", null, select("countdownThreshold", OPTIONS.countdownThreshold, secs)),
    ),
    h3("Break enforcement"),
    group(
      row(
        "Mode",
        s.disciplineLevel === "casual"
          ? "Skip and snooze any time."
          : s.disciplineLevel === "balanced"
            ? "Skip unlocks a few seconds into each break."
            : "No skipping or snoozing. Breaks always run to the end.",
        seg("disciplineLevel", [
          ["casual", "Casual"],
          ["balanced", "Balanced"],
          ["hardcore", "Hardcore"],
        ]),
      ),
      s.disciplineLevel === "balanced" && row("Skip unlocks after", null, select("skipDelay", OPTIONS.skipDelay, secs)),
      row("Snoozes per break", null, select("snoozeLimitPerBreak", OPTIONS.snoozeLimit, (n) => (n ? String(n) : "No limit"))),
      row("Snoozes per day", null, select("snoozeLimitPerDay", OPTIONS.snoozeLimit, (n) => (n ? String(n) : "No limit"))),
      row("Advance skips per day", "Skip the next break before it starts.", select("advanceSkipsPerDay", [0, 1, 2, 3, 5, 10], (n) => (n ? String(n) : "None"))),
      row(
        "Double Escape on the break screen",
        null,
        seg("escapeAction", [
          ["skip", "Skips"],
          ["snooze", "Snoozes"],
          ["none", "Nothing"],
        ]),
      ),
      row("Keep break screen until I press End Break", "Useful if you walk away and want to come back to it.", toggle("holdBreakUntilEnded")),
      row("Lock the screen when a break starts", isMac ? "Puts the display to sleep (locks if your Mac requires a password)." : "Locks Windows 5 seconds into the break.", toggle("lockOnBreak")),
    ),
    h3("Idle"),
    group(
      row("Pause when I step away", null, toggle("idlePauseEnabled", render)),
      s.idlePauseEnabled && row("Pause after inactivity", null, select("idleTimeForPause", OPTIONS.idleTimeForPause, secs)),
      row("Count long absences as a break", "Start a fresh session when you return.", toggle("idleResetEnabled", render)),
      s.idleResetEnabled && row("Reset after inactivity", null, select("idleTimeForReset", OPTIONS.idleTimeForReset, secs)),
      row("Show a notice when I return", null, toggle("showReturnNotice")),
    ),
  ];
}

function smartPause(): Node[] {
  const nodes: (Node | false)[] = [
    ...header("Smart Pause", "FarSight holds breaks while you're presenting, in a call, or in deep focus, then resumes automatically."),
    h3("Deep focus apps"),
    group(appList("deepFocusApps", "App name, e.g. Keynote")),
    el("p", { class: "note", textContent: "Breaks wait while any of these apps is in front." }),
    h3("Calls (Teams, WhatsApp, Zoom…)"),
    group(appList("meetingApps", "App name, e.g. zoom.us")),
    el("p", {
      class: "note",
      textContent:
        "Breaks wait during calls: whenever a physical microphone is in use, or one of these apps is in a video call or sharing your screen. Just having the app open doesn't count. FarSight shows no notifications during calls or videos.",
    }),
    h3("Video playback"),
    group(
      row("Pause while a video plays", "YouTube, Netflix, VLC, QuickTime and other players. Video time is shown in Stats.", toggle("videoPauseEnabled", render)),
      s.videoPauseEnabled &&
        row(
          "Trigger when the video is",
          s.videoFrontmostOnly ? "Only when the video app is in front." : "Playing anywhere, even in a background window.",
          seg("videoFrontmostOnly", [
            [true, "In front"],
            [false, "Anywhere"],
          ]),
        ),
    ),
    s.videoPauseEnabled && h3("Never count as video"),
    s.videoPauseEnabled && group(appList("videoExcludedApps", "App name, e.g. Spotify")),
    h3("Other"),
    group(
      !isMac && row("Pause for fullscreen apps", "Videos, games and presentations.", toggle("pauseForFullscreen")),
      row("Cooldown after smart pause", "If a break is due when the pause ends, wait this long first.", select("smartPauseCooldown", [0, 15, 30, 60, 120], (v) => (v ? secs(v) : "None"))),
    ),
  ];
  return nodes.filter((n): n is Node => n !== false);
}

function wellness(): Node[] {
  const min = (v: number) => `Every ${v / 60} min`;
  return [
    ...header("Wellness Reminders", "Gentle nudges between breaks."),
    group(
      row("Blink reminder", "Prevents dry eyes by nudging you to blink.", toggle("blinkReminderEnabled", render)),
      s.blinkReminderEnabled && row("Frequency", null, select("blinkReminderFrequency", OPTIONS.blinkReminderFrequency, min)),
      row("Preview", null, el("button", { textContent: "Show blink reminder", onclick: () => bridge.cmd("previewWellness", "blink") })),
    ),
    h3("Posture"),
    group(
      row("Posture reminder", "A reminder to sit upright and relax your shoulders.", toggle("postureReminderEnabled", render)),
      s.postureReminderEnabled && row("Frequency", null, select("postureReminderFrequency", OPTIONS.postureReminderFrequency, min)),
      row("Preview", null, el("button", { textContent: "Show posture reminder", onclick: () => bridge.cmd("previewWellness", "posture") })),
    ),
    h3("Display"),
    group(
      row(
        "Position",
        null,
        select("reminderPosition", ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"], (v) =>
          v.replace("-", " ").replace(/\b\w/g, (c) => c.toUpperCase()),
        ),
      ),
      row("Keep reminders during smart pause", null, toggle("remindersDuringPause")),
      row("Reminder sounds", null, toggle("reminderSoundsEnabled")),
      row("Reminder volume", null, slider("reminderVolume")),
    ),
  ];
}

function appearance(): Node[] {
  const grads = el("div", { class: "gradients" });
  GRADIENTS.forEach((_, i) =>
    grads.append(
      el("button", {
        className: s.breakBackground === "gradient" && s.gradient === i ? "on" : "",
        style: `background:${gradientCss(i)}`,
        title: `Gradient ${i + 1}`,
        onclick: async () => (await save({ breakBackground: "gradient", gradient: i }), render()),
      }),
    ),
  );
  const titlesArea = (key: "customShortTitles" | "customLongTitles") => {
    const t = el("textarea", { value: s[key].join("\n"), placeholder: "One title per line (leave empty for built-in titles)" });
    t.setAttribute("style", "width:100%;min-height:70px;font:inherit;color:inherit;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:8px;padding:8px;color-scheme:dark");
    t.onchange = () => save({ [key]: t.value.split("\n").map((x) => x.trim()).filter(Boolean) } as Partial<Settings>);
    return el("div", { style: "padding:12px 16px" }, t);
  };
  return [
    ...header("Break Screen", "Make breaks feel like a moment of calm."),
    group(
      row(
        "Background",
        s.breakBackground === "blur" ? "Your desktop shows through, blurred." : null,
        seg("breakBackground", [
          ["gradient", "Gradient"],
          ["blur", "Blur"],
          ["image", "Image"],
        ]),
      ),
      s.breakBackground === "gradient" && grads,
      s.breakBackground === "image" &&
        row(
          s.backgroundImage ? s.backgroundImage.split(/[\\/]/).pop()! : "No image selected",
          null,
          el("button", {
            textContent: "Choose image…",
            onclick: async () => {
              const p = await bridge.cmd("pickImage");
              if (p) await save({ backgroundImage: p });
              render();
            },
          }),
        ),
      row("Preview", null, el("button", { textContent: "Preview a 10-second break", onclick: () => bridge.cmd("startBreak", "custom", 10) })),
    ),
    h3("Text"),
    group(row("Show current time", null, toggle("showClock")), row("Hide title", null, toggle("hideTitle")), row("Hide message", null, toggle("hideSubtitle"))),
    h3("Custom titles — short breaks"),
    group(titlesArea("customShortTitles")),
    h3("Custom titles — long breaks"),
    group(titlesArea("customLongTitles")),
    h3("Sounds"),
    group(
      row(
        "Break sounds",
        null,
        select("soundPair", ["chime", "bell", "harp", "bubbles", "piano", "whoosh", "none"], (v) => v[0].toUpperCase() + v.slice(1)),
      ),
      row("Preview", null, el("button", { textContent: "▶ Play", onclick: () => bridge.cmd("previewSound", `pair:${s.soundPair}`) })),
      row("Break sound volume", null, slider("breakSoundsVolume")),
    ),
  ];
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const toTime = (t: { hour: number; minute: number }) => `${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
const fromTime = (v: string) => {
  const [h, m] = v.split(":").map(Number);
  return { hour: h || 0, minute: m || 0 };
};

function schedule(): Node[] {
  const office = group(
    row("Only show breaks during office hours", "Outside these hours FarSight stays quiet.", toggle("officeHoursEnabled", render)),
    ...(s.officeHoursEnabled
      ? ([1, 2, 3, 4, 5, 6, 0] as Weekday[]).map((d) => {
          const day = s.officeHours[d];
          const upd = (patch: Partial<typeof day>) => save({ officeHours: { ...s.officeHours, [d]: { ...day, ...patch } } });
          const startI = el("input", { type: "time", value: toTime(day.start), disabled: !day.enabled });
          const endI = el("input", { type: "time", value: toTime(day.end), disabled: !day.enabled });
          startI.onchange = () => upd({ start: fromTime(startI.value) });
          endI.onchange = () => upd({ end: fromTime(endI.value) });
          const cb = el("input", { type: "checkbox", checked: day.enabled });
          cb.onchange = async () => (await upd({ enabled: cb.checked }), render());
          return el(
            "div",
            { class: "row" },
            el("label", { class: "switch" }, cb, el("span")),
            el("div", { class: "text label", textContent: DAY_NAMES[d] }),
            startI,
            el("span", { textContent: "to" }),
            endI,
          );
        })
      : []),
  );

  const planned = el("div", { class: "group" });
  if (!s.plannedBreaks.length) planned.append(el("div", { class: "empty", textContent: "No planned breaks yet — add a lunch break or an afternoon walk." }));
  const updPlanned = (id: string, patch: Partial<PlannedBreak>) =>
    save({ plannedBreaks: s.plannedBreaks.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
  for (const p of s.plannedBreaks) {
    const name = el("input", { type: "text", value: p.name, style: "min-width:150px" });
    name.onchange = () => updPlanned(p.id, { name: name.value });
    const time = el("input", { type: "time", value: toTime(p.time) });
    time.onchange = () => updPlanned(p.id, { time: fromTime(time.value) });
    const dur = el("input", { type: "number", min: "1", max: "120", value: String(p.durationMin), style: "min-width:70px;width:70px" });
    dur.onchange = () => updPlanned(p.id, { durationMin: Math.min(120, Math.max(1, Number(dur.value) || 1)) });
    const days = el("div", { class: "days" });
    DAY_NAMES.forEach((n, i) =>
      days.append(
        el("button", {
          textContent: n[0],
          title: n,
          className: p.days.includes(i as Weekday) ? "on" : "",
          onclick: async () => {
            const has = p.days.includes(i as Weekday);
            const next = has ? p.days.filter((x) => x !== i) : [...p.days, i as Weekday];
            if (!next.length) return alert("Pick at least one day for this planned break.");
            await updPlanned(p.id, { days: next });
            render();
          },
        }),
      ),
    );
    const en = el("input", { type: "checkbox", checked: p.enabled });
    en.onchange = () => updPlanned(p.id, { enabled: en.checked });
    planned.append(
      el(
        "div",
        { class: "planned-item" },
        el("label", { class: "switch" }, en, el("span")),
        name,
        time,
        dur,
        el("span", { textContent: "min" }),
        days,
        el("button", { textContent: "Delete", onclick: async () => (await save({ plannedBreaks: s.plannedBreaks.filter((x) => x.id !== p.id) }), render()) }),
      ),
    );
  }
  return [
    ...header("Schedule", "Office hours and breaks at fixed times."),
    office,
    h3("Planned breaks"),
    planned,
    el(
      "div",
      { class: "btn-row" },
      el("button", {
        textContent: "+ Add planned break",
        onclick: async () => {
          const pb: PlannedBreak = { id: crypto.randomUUID(), name: "Lunch", time: { hour: 13, minute: 0 }, durationMin: 30, days: [1, 2, 3, 4, 5], enabled: true };
          await save({ plannedBreaks: [...s.plannedBreaks, pb] });
          render();
        },
      }),
    ),
    el("p", { class: "note", textContent: "Planned breaks run at fixed times, independently of your focus timer, and reset the cycle when they end. If you're in a meeting, they start once it's over." }),
  ];
}

async function statsTab(): Promise<Node[]> {
  const st: StatsSummary = await api.stats();
  const t = st.today;
  const score = st.score;
  const ring = el("div", { class: "score-gauge" }, gauge(st, 190));
  const verdict =
    score == null
      ? "Not enough screen time yet to calculate today's score."
      : score >= 85
        ? "Excellent rhythm — short sessions and consistent breaks."
        : score >= 65
          ? "Good balance. A few long stretches pulled the score down."
          : "Long sessions without breaks. Try not to skip so often.";
  const max = Math.max(1, ...t.hourly);
  const chart = el("div", { class: "chart" }, ...t.hourly.map((v) => el("div", { class: "bar", style: `height:${(100 * v) / max}%`, title: formatDuration(v) })));
  const labels = el("div", { class: "chart-labels" }, ...t.hourly.map((_, h) => el("span", { textContent: h % 3 === 0 ? String(h) : "" })));
  const median = t.sessions.length ? [...t.sessions].sort((a, b) => a - b)[Math.floor(t.sessions.length / 2)] : 0;
  const stat = (k: string, v: string) => el("div", { class: "stat" }, el("div", { class: "k", textContent: k }), el("div", { class: "v tabular", textContent: v }));
  const week = el(
    "div",
    { class: "group" },
    ...st.history.map((d) =>
      row(
        new Date(d.date + "T12:00:00").toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }),
        formatDuration(d.screenTimeSec) + " screen time",
        el("div", { class: "tabular", style: "font-weight:600", textContent: d.score == null ? "—" : `${d.score}` }),
      ),
    ),
  );
  return [
    ...header("Stats", "How you spent your screen time today."),
    el(
      "div",
      { class: "score-wrap" },
      ring,
      el(
        "div",
        {},
        el("div", { class: "label", style: "font-weight:600;font-size:15px", textContent: "Today's Screen Score" }),
        el("div", { class: "desc", style: "margin-top:6px;color:var(--fg-dim);line-height:1.45", textContent: verdict }),
        el("div", { class: "note", style: "margin:8px 0 0", textContent: "Combines how long your focus sessions were with how consistently you took breaks." }),
      ),
    ),
    el(
      "div",
      { class: "stat-cards" },
      stat("Screen time", formatDuration(t.screenTimeSec)),
      stat("Breaks taken", String(t.breaksTaken + t.naturalBreaks)),
      stat("Breaks skipped", String(t.breaksSkipped)),
      stat("Longest stretch", t.longestSessionSec ? formatDuration(t.longestSessionSec) : "—"),
    ),
    h3("Video watched today"),
    videoBreakdown(t),
    h3("Focus by hour"),
    el("div", { class: "group" }, chart, labels),
    el("p", { class: "note", textContent: `Typical stretch today: ${median ? formatDuration(median) : "—"} · Snoozes: ${t.snoozes} · Natural breaks: ${t.naturalBreaks}` }),
    h3("Last 7 days"),
    week,
  ];
}

function videoBreakdown(t: StatsSummary["today"]): HTMLElement {
  const apps = Object.entries(t.videoApps ?? {})
    .filter(([, sec]) => sec >= 1)
    .sort((a, b) => b[1] - a[1]);
  if (!apps.length) return el("div", { class: "group" }, el("div", { class: "empty", textContent: "No video detected today." }));
  const total = t.videoSec || 1;
  return el(
    "div",
    { class: "group" },
    row("Total", "Breaks are held while you watch, and resume when the video stops.", el("div", { class: "tabular", style: "font-weight:600", textContent: formatDuration(t.videoSec) })),
    ...apps.map(([app, sec]) =>
      row(
        app,
        `${Math.round((100 * sec) / total)}% of video time`,
        el("div", { class: "tabular", style: "font-weight:600", textContent: formatDuration(sec) }),
      ),
    ),
  );
}

function automation(): Node[] {
  const list = el("div", { class: "group" });
  if (!s.automations.length) list.append(el("div", { class: "empty", textContent: "No automations yet." }));
  const upd = (id: string, patch: Partial<Automation>) => save({ automations: s.automations.map((a) => (a.id === id ? { ...a, ...patch } : a)) });
  for (const a of s.automations) {
    const en = el("input", { type: "checkbox", checked: a.enabled });
    en.onchange = () => upd(a.id, { enabled: en.checked });
    const name = el("input", { type: "text", value: a.name, style: "min-width:140px" });
    name.onchange = () => upd(a.id, { name: name.value });
    const trig = el("select");
    for (const [v, l] of [["break-start", "When a break starts"], ["break-end", "When a break ends"]] as const)
      trig.append(el("option", { value: v, textContent: l, selected: a.trigger === v }));
    trig.onchange = () => upd(a.id, { trigger: trig.value as Automation["trigger"] });
    const cmd = el("input", { type: "text", value: a.command, className: "mono", style: "flex:1;min-width:260px" });
    cmd.onchange = () => upd(a.id, { command: cmd.value });
    const result = el("span", { class: "note", style: "margin:0" });
    list.append(
      el(
        "div",
        { class: "auto-item" },
        el("label", { class: "switch" }, en, el("span")),
        name,
        trig,
        cmd,
        el("button", {
          textContent: "Test run",
          onclick: async () => {
            result.textContent = "Running…";
            const r = await bridge.cmd("testAutomation", cmd.value);
            result.textContent = r.ok ? `✓ Success${r.output ? `: ${r.output.slice(0, 80)}` : ""}` : `✗ Failed: ${r.output.slice(0, 120)}`;
          },
        }),
        el("button", { textContent: "Delete", onclick: async () => (await save({ automations: s.automations.filter((x) => x.id !== a.id) }), render()) }),
        result,
      ),
    );
  }
  const example = isMac ? `osascript -e 'tell application "Music" to pause'` : `powershell -Command "(New-Object -ComObject WScript.Shell).SendKeys([char]179)"`;
  return [
    ...header("Automation", "Run a command when a break starts or ends — pause music, set your status, dim lights."),
    list,
    el(
      "div",
      { class: "btn-row" },
      el("button", {
        textContent: "+ Add automation",
        onclick: async () => {
          const a: Automation = { id: crypto.randomUUID(), name: "Pause music", trigger: "break-start", command: example, enabled: true };
          await save({ automations: [...s.automations, a] });
          render();
        },
      }),
    ),
    el("p", {
      class: "note",
      textContent: isMac
        ? "Commands run with /bin/sh. Use osascript for AppleScript, or `shortcuts run \"Name\"` for Shortcuts."
        : "Commands run with cmd.exe. Use powershell -Command \"…\" for PowerShell.",
    }),
  ];
}

async function about(): Promise<Node[]> {
  const info = await bridge.cmd("getPlatform");
  return [
    ...header("About FarSight", `Version ${info.version} · ${info.platform === "darwin" ? "macOS" : info.platform === "win32" ? "Windows" : info.platform}`),
    group(
      row("Your data", "Settings and stats are stored as JSON on this computer only. Nothing is sent anywhere.", null),
      row("The 20-20-20 rule", "Every 20 minutes, look at something 20 feet (6 m) away for 20 seconds.", null),
    ),
    el("div", { class: "btn-row" }, el("button", { textContent: "Quit FarSight", onclick: () => bridge.cmd("quit") })),
  ];
}

const ordinal = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");

// ------------------------------------------------------------------ shell

const RENDER: Record<string, () => Node[] | Promise<Node[]>> = {
  welcome,
  general,
  breaks,
  "smart-pause": smartPause,
  wellness,
  appearance,
  schedule,
  stats: statsTab,
  automation,
  about,
};

function go(tab: string): void {
  current = RENDER[tab] ? tab : "general";
  renderNav();
  void render();
}

function renderNav(): void {
  const nav = document.getElementById("nav")!;
  nav.replaceChildren(
    ...TABS.filter(([id]) => id !== "welcome" || !s.hasCompletedOnboarding || current === "welcome").map(([id, ic, tile, label]) =>
      el("button", { className: id === current ? "active" : "", onclick: () => go(id) }, icon(ic, tile), label),
    ),
  );
}

let renderSeq = 0;
async function render(): Promise<void> {
  const seq = ++renderSeq;
  const top = content.scrollTop;
  const nodes = await RENDER[current]();
  if (seq !== renderSeq) return;
  content.replaceChildren(...nodes);
  content.scrollTop = top;
}

function renderStatus(snap: EngineSnapshot): void {
  const el = document.getElementById("status")!;
  el.textContent =
    snap.status === "working"
      ? `Next break in ${formatClock(snap.remaining)}`
      : snap.status === "break"
        ? "On a break"
        : snap.status === "paused"
          ? "Paused"
          : "Stopped";
}

(async () => {
  s = await api.settings();
  renderNav();
  await render();
  renderStatus(await api.state());
  api.onState(renderStatus);
  api.onSettings((next) => (s = next));
  bridge.on("open-tab", (tab: string) => go(tab));
  setInterval(() => current === "stats" && void render(), 30_000);
})();
