// Types shared between the main process, preload bridge and renderer pages.

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0 = Sunday

export interface TimeOfDay {
  hour: number;
  minute: number;
}

export interface DaySchedule {
  enabled: boolean;
  start: TimeOfDay;
  end: TimeOfDay;
}

export type DisciplineLevel = "casual" | "balanced" | "hardcore";
export type EscapeAction = "skip" | "snooze" | "none";
export type BreakBackground = "gradient" | "blur" | "image";
export type ReminderPosition = "center" | "top-left" | "top-center" | "top-right" | "bottom-left" | "bottom-center" | "bottom-right";
export type ReminderSize = "small" | "medium" | "large";
export type MenuBarDisplay = "icon" | "icon-and-text" | "text";
export type SoundPair = "chime" | "bell" | "harp" | "bubbles" | "piano" | "whoosh" | "none";

export interface PlannedBreak {
  id: string;
  name: string;
  time: TimeOfDay;
  durationMin: number;
  days: Weekday[];
  enabled: boolean;
}

export interface Automation {
  id: string;
  name: string;
  trigger: "break-start" | "break-end";
  /** Shell command run with the platform shell (sh on macOS, cmd on Windows). */
  command: string;
  enabled: boolean;
}

export interface Settings {
  // Core timers (seconds)
  workDuration: number;
  shortBreakDuration: number;
  longBreakEnabled: boolean;
  longBreakDuration: number;
  /** Every Nth break is a long break. */
  longBreakEvery: number;

  // Heads-up before a break
  countdownEnabled: boolean;
  /** Seconds before the break at which the floating countdown appears. */
  countdownThreshold: number;
  reminderEnabled: boolean;
  /** Seconds before the break at which the "Almost time" heads-up appears. */
  reminderThreshold: number;

  // Snooze / skip rules
  disciplineLevel: DisciplineLevel;
  /** Balanced mode: seconds into a break before Skip unlocks. */
  skipDelay: number;
  snoozeLimitPerBreak: number; // 0 = no limit
  snoozeLimitPerDay: number; // 0 = no limit
  advanceSkipsPerDay: number;
  escapeAction: EscapeAction;
  holdBreakUntilEnded: boolean;

  // Idle handling (seconds)
  idlePauseEnabled: boolean;
  idleTimeForPause: number;
  idleResetEnabled: boolean;
  idleTimeForReset: number;
  showReturnNotice: boolean;
  waitForTypingToFinish: boolean;

  // Smart pause
  deepFocusApps: string[];
  meetingApps: string[];
  pauseForFullscreen: boolean;
  smartPauseCooldown: number;
  /** Pause breaks while a video plays. */
  videoPauseEnabled: boolean;
  /** Only when the video app is the frontmost app (otherwise also in the background). */
  videoFrontmostOnly: boolean;
  /** Apps that never count as video playback. */
  videoExcludedApps: string[];

  // Office hours
  officeHoursEnabled: boolean;
  officeHours: Record<Weekday, DaySchedule>;

  // Planned breaks and automation
  plannedBreaks: PlannedBreak[];
  automations: Automation[];

  // Wellness reminders (seconds between reminders)
  blinkReminderEnabled: boolean;
  blinkReminderFrequency: number;
  postureReminderEnabled: boolean;
  postureReminderFrequency: number;
  reminderPosition: ReminderPosition;
  reminderSize: ReminderSize;
  /** Seconds the blink/posture reminder stays on screen. */
  reminderDuration: number;
  /** Dim the rest of the screen while a reminder shows. */
  reminderDim: boolean;
  remindersDuringPause: boolean;

  // Break screen look
  breakBackground: BreakBackground;
  gradient: number;
  backgroundImage: string | null;
  showClock: boolean;
  hideTitle: boolean;
  hideSubtitle: boolean;
  customShortTitles: string[];
  customLongTitles: string[];
  lockOnBreak: boolean;

  // Sounds
  soundPair: SoundPair;
  breakSoundsVolume: number; // 0..1
  reminderSoundsEnabled: boolean;
  reminderVolume: number;

  // App
  launchAtLogin: boolean;
  menuBarDisplay: MenuBarDisplay;
  statsEnabled: boolean;
  shortcuts: {
    startBreak: string;
    togglePause: string;
    snooze: string;
    skip: string;
  };
  hasCompletedOnboarding: boolean;
  /** Bumped when defaults change in a way stored settings must pick up. */
  settingsVersion: number;
}

export type BreakKind = "short" | "long" | "custom" | "planned";
export type PauseReason =
  | "manual"
  | "idle"
  | "screen-locked"
  | "deep-focus"
  | "meeting"
  | "fullscreen"
  | "video"
  | "office-hours"
  | "suspended";

export interface BreakInfo {
  kind: BreakKind;
  title: string;
  message: string;
  duration: number;
  elapsed: number;
  startedAt: number;
  plannedId?: string;
}

export interface EngineSnapshot {
  status: "stopped" | "working" | "paused" | "break";
  workElapsed: number;
  workDuration: number;
  /** Seconds until the next break while working. */
  remaining: number;
  nextBreakIsLong: boolean;
  breaksTaken: number;
  pause: { reason: PauseReason; detail?: string; until: number | null } | null;
  currentBreak: BreakInfo | null;
  snoozesThisBreak: number;
  snoozesToday: number;
  skipsToday: number;
  advanceSkipsToday: number;
  canSkip: boolean;
  canSnooze: boolean;
  skipUnlocksIn: number;
}

export interface DayStats {
  date: string; // YYYY-MM-DD
  screenTimeSec: number;
  breaksTaken: number;
  breaksSkipped: number;
  naturalBreaks: number;
  snoozes: number;
  sessions: number[]; // session lengths in seconds
  longestSessionSec: number;
  hourly: number[]; // 24 buckets of focused seconds
  /** Seconds of video watched, total and per app. */
  videoSec: number;
  videoApps: Record<string, number>;
}

export interface StatsSummary {
  today: DayStats;
  score: number | null;
  parts: { score: number; pacing: number; discipline: number; pacingPenalty: number; disciplinePenalty: number } | null;
  history: { date: string; score: number | null; screenTimeSec: number }[];
}
