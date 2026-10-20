// Decides which smart-pause condition (if any) is active from an activity sample.
// Pure logic (no Electron imports) so it is unit-tested.
import type { PauseReason, Settings } from "../shared/types";

export interface ActivitySample {
  frontApp: string | null;
  frontAppId: string | null;
  fullscreen: boolean;
  /** Apps currently using the microphone. */
  micApps: string[];
  /** Apps currently playing video. */
  videoApps: string[];
}

const SELF = /^(farsight|electron)$/i;

/** Music players report media sessions too, but aren't video. */
const MUSIC_APPS = ["spotify", "music", "itunes", "applemusic", "tidal", "deezer", "amazon music", "foobar2000", "winamp", "musicbee", "vlc audio"];

const lc = (s: string) => s.toLowerCase();
const nameMatches = (a: string, b: string) => {
  const x = lc(a);
  const y = lc(b);
  return x === y || x.includes(y) || y.includes(x);
};

/** Case-insensitive match of the frontmost app against a user list (by name or bundle id). */
export function matchesApp(sample: Pick<ActivitySample, "frontApp" | "frontAppId">, list: string[]): string | null {
  const candidates = [sample.frontApp, sample.frontAppId].filter(Boolean).map((s) => lc(s!));
  for (const entry of list) {
    const e = lc(entry);
    if (candidates.some((c) => c === e || c.includes(e))) return entry;
  }
  return null;
}

/** Friendly app name for helper/OS identifiers (e.g. Safari's WebKit media process). */
export function normalizeVideoApp(name: string): string {
  if (/^com\.apple\.WebKit/i.test(name)) return "Safari";
  if (/^msedge$/i.test(name)) return "Microsoft Edge";
  if (/^chrome$/i.test(name)) return "Google Chrome";
  return name;
}

/** The app currently playing video, honouring exclusions and the frontmost-only option. */
export function detectVideo(sample: ActivitySample, settings: Settings): string | null {
  // Keep the raw id (matches the OS process name) next to the friendly name (shown to users).
  const apps = sample.videoApps
    .map((raw) => ({ raw, name: normalizeVideoApp(raw) }))
    .filter(({ raw, name }) => !SELF.test(raw) && !SELF.test(name))
    .filter(({ name }) => !MUSIC_APPS.some((m) => lc(name).includes(m)))
    .filter(({ raw, name }) => !settings.videoExcludedApps.some((x) => nameMatches(name, x) || nameMatches(raw, x)))
    // Call apps keep the display awake during calls; those count as meetings, not video.
    .filter(({ raw, name }) => !settings.meetingApps.some((m) => nameMatches(name, m) || nameMatches(raw, m)));
  if (!apps.length) return null;
  if (!settings.videoFrontmostOnly) return apps[0].name;
  const front = sample.frontApp ?? "";
  if (!front) return null;
  return apps.find(({ raw, name }) => nameMatches(name, front) || nameMatches(raw, front))?.name ?? null;
}

/** The call app currently in a call, judged from signals rather than which app is in front. */
export function detectCall(sample: ActivitySample, settings: Settings): string | null {
  const isCallApp = (a: string) => settings.meetingApps.some((m) => nameMatches(a, m));
  // Video calls and screen sharing keep the display awake, like video players do.
  const awake = sample.videoApps.find((a) => !SELF.test(a) && isCallApp(a));
  if (awake) return awake;
  // Voice calls: a physical microphone is in use.
  const mic = sample.micApps.find((a) => !SELF.test(a));
  if (!mic) return null;
  if (mic !== "Microphone") return mic; // Windows reports the app using the mic
  const front = sample.frontApp;
  return front && isCallApp(front) ? front : "Microphone";
}

export function detectSmartPause(sample: ActivitySample, settings: Settings): { reason: PauseReason; detail?: string } | null {
  const focus = matchesApp(sample, settings.deepFocusApps);
  if (focus) return { reason: "deep-focus", detail: focus };
  const call = detectCall(sample, settings);
  if (call) return { reason: "meeting", detail: call };
  if (settings.videoPauseEnabled) {
    const video = detectVideo(sample, settings);
    if (video) return { reason: "video", detail: video };
  }
  if (settings.pauseForFullscreen && sample.fullscreen) return { reason: "fullscreen", detail: sample.frontApp ?? undefined };
  return null;
}

/** While on a call or watching a video FarSight shows no notifications and plays no reminder sounds. */
export function isQuietReason(reason: PauseReason | undefined | null): boolean {
  return reason === "meeting" || reason === "video";
}
