import { describe, expect, it } from "vitest";
import {
  evaluateIngestionHealth,
  evaluateIngestionLag,
  evaluateJournalBacklog,
  evaluateUnexpectedInserts,
} from "./evaluate-ingestion-health";

const now = new Date("2026-09-08T12:00:00Z");
function minutesAgo(minutes: number): Date {
  return new Date(now.getTime() - minutes * 60_000);
}

describe("evaluateIngestionLag", () => {
  it("is not alarming shortly after the last successful ingestion", () => {
    expect(evaluateIngestionLag(minutesAgo(30), now)).toEqual({ lagMinutes: 30, alarming: false });
  });

  it("is not alarming at exactly the 90-minute threshold — the doc says '> 90 min'", () => {
    expect(evaluateIngestionLag(minutesAgo(90), now)).toEqual({ lagMinutes: 90, alarming: false });
  });

  it("alarms just past the 90-minute threshold", () => {
    const result = evaluateIngestionLag(minutesAgo(91), now);
    expect(result.alarming).toBe(true);
    expect(result.lagMinutes).toBe(91);
  });

  it("alarms on a fresh environment with no ingestion ever — null lag is not zero lag", () => {
    expect(evaluateIngestionLag(null, now)).toEqual({ lagMinutes: null, alarming: true });
  });
});

describe("evaluateJournalBacklog", () => {
  it("is not alarming with an empty backlog", () => {
    expect(evaluateJournalBacklog([], now)).toEqual({
      unprocessedCount: 0,
      oldestUnprocessedAgeMinutes: null,
      alarming: false,
    });
  });

  it("is not alarming for a young backlog, even with several rows", () => {
    const result = evaluateJournalBacklog([minutesAgo(5), minutesAgo(20), minutesAgo(45)], now);
    expect(result.unprocessedCount).toBe(3);
    expect(result.oldestUnprocessedAgeMinutes).toBe(45);
    expect(result.alarming).toBe(false);
  });

  it("is not alarming at exactly the 60-minute threshold — §8.11 says 'older than 1 hour'", () => {
    const result = evaluateJournalBacklog([minutesAgo(60)], now);
    expect(result.alarming).toBe(false);
  });

  it("alarms when even one row is older than an hour, regardless of the rest", () => {
    const result = evaluateJournalBacklog([minutesAgo(5), minutesAgo(61)], now);
    expect(result.unprocessedCount).toBe(2);
    expect(result.oldestUnprocessedAgeMinutes).toBe(61);
    expect(result.alarming).toBe(true);
  });
});

describe("evaluateUnexpectedInserts", () => {
  it("is not alarming with no full_sync history at all", () => {
    expect(evaluateUnexpectedInserts([])).toEqual({ recentInsertedCounts: [], alarming: false });
  });

  it("is not alarming with only one run of history — 'sustained' needs at least two", () => {
    const result = evaluateUnexpectedInserts([50]);
    expect(result.recentInsertedCounts).toEqual([50]);
    expect(result.alarming).toBe(false);
  });

  it("is not alarming for a single non-zero run followed by zero — routine, not sustained", () => {
    const result = evaluateUnexpectedInserts([12, 0]);
    expect(result.alarming).toBe(false);
  });

  it("alarms on two consecutive non-zero runs", () => {
    const result = evaluateUnexpectedInserts([7, 3]);
    expect(result.recentInsertedCounts).toEqual([7, 3]);
    expect(result.alarming).toBe(true);
  });

  it("only looks at the two most recent runs, ignoring older history", () => {
    // Most-recent-first: last two are 5 and 0 — not sustained, even though older runs were bad.
    const result = evaluateUnexpectedInserts([5, 0, 10, 10]);
    expect(result.recentInsertedCounts).toEqual([5, 0]);
    expect(result.alarming).toBe(false);
  });
});

describe("evaluateIngestionHealth", () => {
  it("is not alarming when every sub-metric is healthy", () => {
    const report = evaluateIngestionHealth({
      lastRetrievedAt: minutesAgo(10),
      unprocessedJournalReceivedAts: [],
      mostRecentFullSyncInsertedCountsFirst: [0, 0],
      now,
    });
    expect(report.alarming).toBe(false);
  });

  it("is alarming when only the lag metric is bad, and only that", () => {
    const report = evaluateIngestionHealth({
      lastRetrievedAt: minutesAgo(200),
      unprocessedJournalReceivedAts: [],
      mostRecentFullSyncInsertedCountsFirst: [0, 0],
      now,
    });
    expect(report.alarming).toBe(true);
    expect(report.lag.alarming).toBe(true);
    expect(report.journalBacklog.alarming).toBe(false);
    expect(report.unexpectedInserts.alarming).toBe(false);
  });

  it("is alarming when only the journal backlog is bad", () => {
    const report = evaluateIngestionHealth({
      lastRetrievedAt: minutesAgo(5),
      unprocessedJournalReceivedAts: [minutesAgo(90)],
      mostRecentFullSyncInsertedCountsFirst: [],
      now,
    });
    expect(report.alarming).toBe(true);
    expect(report.journalBacklog.alarming).toBe(true);
  });

  it("is alarming when only unexpected_inserts is bad", () => {
    const report = evaluateIngestionHealth({
      lastRetrievedAt: minutesAgo(5),
      unprocessedJournalReceivedAts: [],
      mostRecentFullSyncInsertedCountsFirst: [100, 80],
      now,
    });
    expect(report.alarming).toBe(true);
    expect(report.unexpectedInserts.alarming).toBe(true);
  });
});
