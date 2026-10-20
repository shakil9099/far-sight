import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings } from "../src/shared/defaults";
import { detectCall, detectSmartPause, detectVideo, isQuietReason, type ActivitySample } from "../src/main/smartpause";
import { Engine } from "../src/shared/engine";
import { StatsBook } from "../src/shared/stats";

const sample = (over: Partial<ActivitySample> = {}): ActivitySample => ({
  frontApp: "Brave Browser",
  frontAppId: "com.brave.Browser",
  fullscreen: false,
  micApps: [],
  videoApps: [],
  ...over,
});

describe("video detection", () => {
  it("detects video in the frontmost app", () => {
    expect(detectVideo(sample({ videoApps: ["Brave Browser"] }), DEFAULT_SETTINGS)).toBe("Brave Browser");
    expect(detectSmartPause(sample({ videoApps: ["Brave Browser"] }), DEFAULT_SETTINGS)).toEqual({ reason: "video", detail: "Brave Browser" });
  });

  it("ignores background video unless 'anywhere' is chosen", () => {
    const bg = sample({ frontApp: "Code", frontAppId: "com.microsoft.VSCode", videoApps: ["Brave Browser"] });
    expect(detectVideo(bg, DEFAULT_SETTINGS)).toBeNull();
    expect(detectVideo(bg, { ...DEFAULT_SETTINGS, videoFrontmostOnly: false })).toBe("Brave Browser");
  });

  it("skips excluded apps, music players and call apps", () => {
    expect(detectVideo(sample({ videoApps: ["Brave Browser"] }), { ...DEFAULT_SETTINGS, videoExcludedApps: ["brave"] })).toBeNull();
    expect(detectVideo(sample({ frontApp: "Spotify", videoApps: ["Spotify"] }), DEFAULT_SETTINGS)).toBeNull();
    expect(detectVideo(sample({ frontApp: "zoom.us", videoApps: ["zoom.us"] }), DEFAULT_SETTINGS)).toBeNull();
  });

  it("maps Safari's WebKit media process and Windows ids to app names", () => {
    expect(detectVideo(sample({ frontApp: "Safari", videoApps: ["com.apple.WebKit.GPU"] }), DEFAULT_SETTINGS)).toBe("Safari");
    expect(detectVideo(sample({ frontApp: "msedge", videoApps: ["MSEdge"] }), DEFAULT_SETTINGS)).toBe("Microsoft Edge");
  });

  it("can be turned off, and meetings take priority", () => {
    expect(detectSmartPause(sample({ videoApps: ["Brave Browser"] }), { ...DEFAULT_SETTINGS, videoPauseEnabled: false })).toBeNull();
    expect(detectSmartPause(sample({ videoApps: ["Brave Browser"], micApps: ["Microphone"] }), DEFAULT_SETTINGS)?.reason).toBe("meeting");
  });
});

describe("call detection", () => {
  it("does not treat a chat app in front as a call", () => {
    expect(detectCall(sample({ frontApp: "WhatsApp" }), DEFAULT_SETTINGS)).toBeNull();
    expect(detectCall(sample({ frontApp: "Microsoft Teams" }), DEFAULT_SETTINGS)).toBeNull();
    expect(detectSmartPause(sample({ frontApp: "Microsoft Teams" }), DEFAULT_SETTINGS)).toBeNull();
  });

  it("detects a voice call from the microphone and names the call app in front", () => {
    expect(detectCall(sample({ frontApp: "WhatsApp", micApps: ["Microphone"] }), DEFAULT_SETTINGS)).toBe("WhatsApp");
    expect(detectCall(sample({ frontApp: "Code", micApps: ["Microphone"] }), DEFAULT_SETTINGS)).toBe("Microphone");
    expect(detectCall(sample({ frontApp: "Code", micApps: ["ms-teams"] }), DEFAULT_SETTINGS)).toBe("ms-teams");
  });

  it("detects a video call from a call app keeping the display awake", () => {
    const s = sample({ frontApp: "Code", videoApps: ["Microsoft Teams"] });
    expect(detectSmartPause(s, DEFAULT_SETTINGS)).toEqual({ reason: "meeting", detail: "Microsoft Teams" });
  });

  it("prefers the call over a video playing at the same time", () => {
    const s = sample({ frontApp: "Brave Browser", videoApps: ["Brave Browser", "WhatsApp"], micApps: ["Microphone"] });
    expect(detectSmartPause(s, DEFAULT_SETTINGS)?.reason).toBe("meeting");
  });

  it("is quiet during calls and videos only", () => {
    expect(isQuietReason("meeting")).toBe(true);
    expect(isQuietReason("video")).toBe(true);
    expect(isQuietReason("deep-focus")).toBe(false);
    expect(isQuietReason("idle")).toBe(false);
    expect(isQuietReason(undefined)).toBe(false);
  });

  it("adds WhatsApp, Slack and Discord to call apps saved by older versions", () => {
    const old = mergeSettings({ meetingApps: ["Zoom", "slack"] } as never);
    expect(old.meetingApps).toEqual(["Zoom", "slack", "WhatsApp", "Discord"]);
    const current = mergeSettings({ meetingApps: ["Zoom"], settingsVersion: 2 });
    expect(current.meetingApps).toEqual(["Zoom"]);
  });
});

describe("video pauses the timer", () => {
  it("stops the work clock while a video plays and resumes after", () => {
    const T0 = new Date(2026, 9, 20, 10, 0, 0).getTime();
    const st = { ...DEFAULT_SETTINGS, workDuration: 600, smartPauseCooldown: 0 };
    const e = new Engine(st, T0);
    const ctx = { idleSec: 0, screenLocked: false, suspended: false, outsideOfficeHours: false, smartPause: null };
    e.tick(T0, ctx);
    for (let i = 1; i <= 100; i++) e.tick(T0 + i * 1000, ctx);
    for (let i = 101; i <= 400; i++) e.tick(T0 + i * 1000, { ...ctx, smartPause: { reason: "video", detail: "Brave Browser" } });
    expect(e.snapshot().status).toBe("paused");
    expect(e.snapshot().pause?.reason).toBe("video");
    expect(e.snapshot().workElapsed).toBeCloseTo(100);
    for (let i = 401; i <= 410; i++) e.tick(T0 + i * 1000, ctx);
    expect(e.snapshot().status).toBe("working");
    expect(e.snapshot().workElapsed).toBeCloseTo(110);
  });

  it("records video time per app in stats, including days saved before video tracking", () => {
    const T0 = new Date(2026, 9, 20, 10, 0, 0).getTime();
    const legacy = { "2026-10-20": { date: "2026-10-20", screenTimeSec: 10, breaksTaken: 0, breaksSkipped: 0, naturalBreaks: 0, snoozes: 0, sessions: [], longestSessionSec: 0, hourly: new Array(24).fill(0) } };
    const book = new StatsBook(legacy as never);
    book.addVideo(T0, 120, "Brave Browser");
    book.addVideo(T0, 30, "VLC");
    book.addVideo(T0, 60, "Brave Browser");
    const d = book.day(T0);
    expect(d.videoSec).toBe(210);
    expect(d.videoApps).toEqual({ "Brave Browser": 180, VLC: 30 });
  });
});
