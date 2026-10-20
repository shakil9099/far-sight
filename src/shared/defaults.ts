// Option lists shown in the settings UI (seconds). Defaults live in src-tauri/src/settings.rs.
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
