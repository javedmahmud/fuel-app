import { describe, expect, it } from "vitest";
import { billingMonthFor, checkBudget, USABLE_BUDGET } from "./budget-guard";

function fakeDbWithCount(n: number) {
  return {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ n }]),
      }),
    }),
  };
}

describe("billingMonthFor", () => {
  it("formats as YYYY-MM, zero-padded", () => {
    expect(billingMonthFor(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01");
    expect(billingMonthFor(new Date("2026-11-30T23:59:59Z"))).toBe("2026-11");
  });
});

describe("checkBudget", () => {
  it("allows a call well under budget with no pace concern", async () => {
    // Day 5 of a 30-day month, 100 calls so far — nowhere near the pro-rata pace or the cap.
    const now = new Date("2026-09-05T12:00:00Z");
    const result = await checkBudget(fakeDbWithCount(100) as never, now, true);
    expect(result).toEqual({ ok: true, value: { paceExceeded: false } });
  });

  it("refuses outright at the absolute USABLE_BUDGET, regardless of essential", async () => {
    const now = new Date("2026-09-15T12:00:00Z");
    const result = await checkBudget(fakeDbWithCount(USABLE_BUDGET) as never, now, true);
    expect(result).toEqual({ ok: false, error: { type: "budget_exceeded" } });
  });

  it("refuses a non-essential call when pace is exceeded, even under the absolute cap", async () => {
    // Day 6 of a 30-day month: pro-rata expected ~= (6/30)*2250 = 450. 1000 calls is way over
    // 20% tolerance (540) but nowhere near the absolute 2250 cap — this is exactly the "catches
    // runaway consumption on day 6 rather than day 27" scenario from §7.7.
    const now = new Date("2026-09-06T12:00:00Z");
    const result = await checkBudget(fakeDbWithCount(1000) as never, now, false);
    expect(result).toEqual({ ok: false, error: { type: "budget_exceeded" } });
  });

  it("allows an essential call through even when pace is exceeded, flagging it", async () => {
    const now = new Date("2026-09-06T12:00:00Z");
    const result = await checkBudget(fakeDbWithCount(1000) as never, now, true);
    expect(result).toEqual({ ok: true, value: { paceExceeded: true } });
  });

  it("does not flag pace as exceeded right at the 20% tolerance boundary", async () => {
    // Day 10 of a 30-day month: pro-rata = (10/30)*2250 = 750. 20% over = 900 exactly.
    const now = new Date("2026-09-10T12:00:00Z");
    const atBoundary = await checkBudget(fakeDbWithCount(900) as never, now, false);
    expect(atBoundary).toEqual({ ok: true, value: { paceExceeded: false } });

    const justOver = await checkBudget(fakeDbWithCount(901) as never, now, false);
    expect(justOver.ok).toBe(false);
  });
});
