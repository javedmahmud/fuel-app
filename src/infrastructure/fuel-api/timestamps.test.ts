import { describe, expect, it } from "vitest";
import { buildRequestTimeStamp, parseLastUpdated } from "./timestamps";

describe("parseLastUpdated", () => {
  it("parses the confirmed real format (dd/MM/yyyy HH:mm:ss, 24h) — §7.1", () => {
    // "26/08/2026 09:05:17" Sydney, AEST (+10, August is outside DST) -> 2026-08-25T23:05:17Z
    expect(parseLastUpdated("26/08/2026 09:05:17")?.toISOString()).toBe("2026-08-25T23:05:17.000Z");
  });

  it("resolves AEDT (+11), not a hardcoded +10, for a date inside daylight saving", () => {
    // The spike's own parser hardcoded +10 and flagged this exact case as unsafe.
    // "26/01/2026 09:05:17" Sydney, AEDT (+11) -> 2026-01-25T22:05:17Z
    expect(parseLastUpdated("26/01/2026 09:05:17")?.toISOString()).toBe("2026-01-25T22:05:17.000Z");
  });

  it("returns undefined for ISO 8601 input — the whole point is this format is NOT ISO", () => {
    expect(parseLastUpdated("2026-08-26T09:05:17Z")).toBeUndefined();
  });

  it("returns undefined for a regex-shaped but impossible value (month 13)", () => {
    expect(parseLastUpdated("26/13/2026 09:05:17")).toBeUndefined();
  });

  it("returns undefined for a regex-shaped but impossible value (hour 25)", () => {
    expect(parseLastUpdated("26/08/2026 25:05:17")).toBeUndefined();
  });

  it("returns undefined for garbage input rather than throwing", () => {
    expect(parseLastUpdated("not a timestamp")).toBeUndefined();
    expect(parseLastUpdated("")).toBeUndefined();
  });
});

describe("buildRequestTimeStamp", () => {
  it("produces dd/MM/yyyy hh:mm:ss AM/PM in Sydney local time — §7.1's confirmed header shape", () => {
    // 2026-08-26T09:05:17Z is 2026-08-26 19:05:17 in Sydney (AEST, +10)
    expect(buildRequestTimeStamp(new Date("2026-08-26T09:05:17Z"))).toBe("26/08/2026 07:05:17 PM");
  });

  it("uses AM for a Sydney-morning UTC instant", () => {
    // 2026-08-25T23:05:17Z is 2026-08-26 09:05:17 in Sydney
    expect(buildRequestTimeStamp(new Date("2026-08-25T23:05:17Z"))).toBe("26/08/2026 09:05:17 AM");
  });
});
