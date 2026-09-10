import { describe, expect, it } from "vitest";

import { formatRelativeTime } from "./format-relative-time";

const now = new Date("2026-09-10T12:00:00Z");

describe("formatRelativeTime", () => {
  it("says 'just now' for under a minute", () => {
    expect(formatRelativeTime(new Date("2026-09-10T11:59:35Z"), now)).toBe("just now");
  });

  it("uses singular minute for exactly 1", () => {
    expect(formatRelativeTime(new Date("2026-09-10T11:59:00Z"), now)).toBe("1 minute ago");
  });

  it("uses plural minutes", () => {
    expect(formatRelativeTime(new Date("2026-09-10T11:45:00Z"), now)).toBe("15 minutes ago");
  });

  it("switches to hours at 60 minutes", () => {
    expect(formatRelativeTime(new Date("2026-09-10T11:00:00Z"), now)).toBe("1 hour ago");
  });

  it("uses plural hours", () => {
    expect(formatRelativeTime(new Date("2026-09-10T06:00:00Z"), now)).toBe("6 hours ago");
  });

  it("switches to days at 24 hours", () => {
    expect(formatRelativeTime(new Date("2026-09-09T12:00:00Z"), now)).toBe("1 day ago");
  });

  it("uses plural days", () => {
    expect(formatRelativeTime(new Date("2026-09-05T12:00:00Z"), now)).toBe("5 days ago");
  });
});
