import type { DaySchedule, Settings, Weekday } from "./types";

const day = (enabled: boolean): DaySchedule => ({
  enabled,
  start: { hour: 9, minute: 0 },
  end: { hour: 18, minute: 0 },
});

export const DEFAULT_SETTINGS: Settings = {
  // 20-20-20 rule: every 20 minutes, look 20 feet away for 20 seconds.
  workDuration: 20 * 60,
  shortBreakDuration: 20,
  longBreakEnabled: true,
  longBreakDuration: 5 * 60,
  longBreakEvery: 3,

  countdownEnabled: true,
  countdownThreshold: 10,
  reminderEnabled: true,
  reminderThreshold: 60,

  disciplineLevel: "balanced",
  skipDelay: 5,
  snoozeLimitPerBreak: 0,
  snoozeLimitPerDay: 0,
  advanceSkipsPerDay: 3,
  escapeAction: "skip",
  holdBreakUntilEnded: false,

  idlePauseEnabled: true,
  idleTimeForPause: 60,
  idleResetEnabled: true,
  idleTimeForReset: 5 * 60,
  showReturnNotice: true,
  waitForTypingToFinish: true,

  deepFocusApps: [],
  meetingApps: ["zoom.us", "Zoom", "Microsoft Teams", "Teams", "ms-teams", "Webex", "FaceTime", "Skype", "Google Meet"],
  pauseForFullscreen: true,
  smartPauseCooldown: 30,

  officeHoursEnabled: false,
  officeHours: {
    0: day(false),
    1: day(true),
    2: day(true),
    3: day(true),
    4: day(true),
    5: day(true),
    6: day(false),
  } as Record<Weekday, DaySchedule>,

  plannedBreaks: [],
  automations: [],

  blinkReminderEnabled: false,
  blinkReminderFrequency: 5 * 60,
  postureReminderEnabled: false,
  postureReminderFrequency: 15 * 60,
  reminderPosition: "top-right",
  remindersDuringPause: false,

  breakBackground: "gradient",
  gradient: 1,
  backgroundImage: null,
  showClock: true,
  hideTitle: false,
  hideSubtitle: false,
  customShortTitles: [],
  customLongTitles: [],
  lockOnBreak: false,

  soundPair: "chime",
  breakSoundsVolume: 0.6,
  reminderSoundsEnabled: true,
  reminderVolume: 0.4,

  launchAtLogin: false,
  menuBarDisplay: "icon-and-text",
  statsEnabled: true,
  shortcuts: {
    startBreak: "CommandOrControl+Alt+B",
    togglePause: "CommandOrControl+Alt+P",
    snooze: "CommandOrControl+Alt+S",
    skip: "CommandOrControl+Alt+K",
  },
  hasCompletedOnboarding: false,
};

/** Option lists shown in settings (seconds). */
export const OPTIONS = {
  workDuration: [5, 10, 15, 20, 25, 30, 40, 45, 50, 60, 90].map((m) => m * 60),
  shortBreakDuration: [10, 15, 20, 30, 45, 60, 90, 120, 180, 300],
  longBreakDuration: [2, 3, 5, 7, 10, 15, 20, 30].map((m) => m * 60),
  longBreakEvery: [2, 3, 4, 5, 6],
  countdownThreshold: [5, 10, 15, 30],
  reminderThreshold: [0, 30, 60, 120, 300],
  idleTimeForPause: [30, 60, 120, 180, 300],
  idleTimeForReset: [2, 3, 5, 10, 15, 30].map((m) => m * 60),
  blinkReminderFrequency: [1, 2, 3, 5, 10, 15, 20].map((m) => m * 60),
  postureReminderFrequency: [5, 10, 15, 20, 30, 45, 60].map((m) => m * 60),
  skipDelay: [3, 5, 10, 15, 30],
  snoozeLimit: [0, 1, 2, 3, 5, 10],
};

export function mergeSettings(stored: Partial<Settings> | null | undefined): Settings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) } as Settings;
  merged.shortcuts = { ...DEFAULT_SETTINGS.shortcuts, ...(stored?.shortcuts ?? {}) };
  merged.officeHours = { ...DEFAULT_SETTINGS.officeHours, ...(stored?.officeHours ?? {}) };
  return merged;
}
