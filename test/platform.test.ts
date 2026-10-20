import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../src/shared/defaults";
import { isOutsideOfficeHours } from "../src/main/platform";
import { matchesApp } from "../src/main/smartpause";

describe("office hours", () => {
  const s = { ...DEFAULT_SETTINGS, officeHoursEnabled: true };
  it("is inside on a weekday at 10:00 and outside at 19:00 and on Sunday", () => {
    expect(isOutsideOfficeHours(s, new Date(2026, 9, 20, 10, 0))).toBe(false); // Tue
    expect(isOutsideOfficeHours(s, new Date(2026, 9, 20, 19, 0))).toBe(true);
    expect(isOutsideOfficeHours(s, new Date(2026, 9, 18, 12, 0))).toBe(true); // Sun
  });
  it("handles schedules crossing midnight", () => {
    const night = {
      ...s,
      officeHours: { ...s.officeHours, 2: { enabled: true, start: { hour: 22, minute: 0 }, end: { hour: 2, minute: 0 } } },
    };
    expect(isOutsideOfficeHours(night, new Date(2026, 9, 20, 23, 0))).toBe(false);
    expect(isOutsideOfficeHours(night, new Date(2026, 9, 20, 1, 0))).toBe(false);
    expect(isOutsideOfficeHours(night, new Date(2026, 9, 20, 12, 0))).toBe(true);
  });
  it("is never outside when disabled", () => {
    expect(isOutsideOfficeHours(DEFAULT_SETTINGS, new Date(2026, 9, 18, 3, 0))).toBe(false);
  });
});

describe("app matching", () => {
  it("matches by name or bundle id, case-insensitively", () => {
    const sample = { frontApp: "zoom.us", frontAppId: "us.zoom.xos" };
    expect(matchesApp(sample, ["Zoom.us"])).toBe("Zoom.us");
    expect(matchesApp(sample, ["us.zoom.xos"])).toBe("us.zoom.xos");
    expect(matchesApp(sample, ["Keynote"])).toBeNull();
  });
});
