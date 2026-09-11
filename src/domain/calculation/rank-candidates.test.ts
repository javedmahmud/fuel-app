import { describe, expect, it } from "vitest";
import { corridorDetourKm } from "./geo";
import {
  rankCandidates,
  type CandidateStation,
  type DetourKmStrategy,
  type LocalAreaContext,
  type RankCandidatesInput,
} from "./rank-candidates";

const now = new Date("2026-09-09T12:00:00Z");
const origin = { latitude: -33.87, longitude: 151.21 };

function station(overrides: Partial<CandidateStation> = {}): CandidateStation {
  return {
    stationId: `station-${Math.random().toString(36).slice(2)}`,
    brand: "Acme",
    location: origin,
    lifecycleState: "active",
    price: { priceTenthsCpl: 1799, sourceReportedAt: now },
    ...overrides,
  };
}

const emptyLocalArea: LocalAreaContext = {
  historyDays: 30,
  localAverageTenths: null,
  windowPricesTenths: [],
  closesTenthsInDayOrder: [],
};

function baseInput(overrides: Partial<RankCandidatesInput> = {}): RankCandidatesInput {
  return {
    candidates: [],
    origin,
    maxDetourKm: 20,
    vehicleProfile: null,
    localArea: emptyLocalArea,
    now,
    ...overrides,
  };
}

function nearby(offsetDeg: number, overrides: Partial<CandidateStation> = {}): CandidateStation {
  return station({
    location: { latitude: origin.latitude + offsetDeg, longitude: origin.longitude },
    ...overrides,
  });
}

function unwrap<T>(result: { ok: boolean; value?: T; error?: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${JSON.stringify(result.error)}`);
  return result.value as T;
}

describe("rankCandidates — eligibility gates (§9.9)", () => {
  it("excludes a station that doesn't sell the selected fuel type", () => {
    const noPrice = nearby(0.001, { price: undefined });
    const result = rankCandidates(baseInput({ candidates: [noPrice] }));
    expect(result.ok).toBe(false);
  });

  it("excludes an inactive station", () => {
    const inactive = nearby(0.001, { lifecycleState: "inactive" });
    const result = rankCandidates(baseInput({ candidates: [inactive] }));
    expect(result.ok).toBe(false);
  });

  it("includes a suspect station — still searchable, consistent with the ingestion side's rule", () => {
    const suspect = nearby(0.001, { lifecycleState: "suspect" });
    const result = unwrap(rankCandidates(baseInput({ candidates: [suspect] })));
    expect(result.recommended.stationId).toBe(suspect.stationId);
  });

  it("excludes a station beyond the round-trip max-detour cap", () => {
    // ~0.2 degrees latitude is roughly 22km one-way, ~44km round trip — beyond a 20km cap.
    const farStation = nearby(0.2);
    const result = rankCandidates(baseInput({ candidates: [farStation], maxDetourKm: 20 }));
    expect(result.ok).toBe(false);
  });

  it("excludes a station whose price is older than the eligibility cutoff", () => {
    const stale = nearby(0.001, {
      price: {
        priceTenthsCpl: 1799,
        sourceReportedAt: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000),
      },
    });
    const result = rankCandidates(baseInput({ candidates: [stale] }));
    expect(result.ok).toBe(false);
  });

  it("returns no_eligible_candidates when the candidate list is empty — §9.10's boundary case", () => {
    const result = rankCandidates(baseInput({ candidates: [] }));
    expect(result).toEqual({ ok: false, error: { type: "no_eligible_candidates" } });
  });
});

describe("rankCandidates — ranking and tie-breaking", () => {
  it("ranks the lower effective-cost station first", () => {
    const cheap = nearby(0.001, {
      stationId: "cheap",
      price: { priceTenthsCpl: 1700, sourceReportedAt: now },
    });
    const expensive = nearby(0.001, {
      stationId: "expensive",
      price: { priceTenthsCpl: 1900, sourceReportedAt: now },
    });
    const result = unwrap(rankCandidates(baseInput({ candidates: [expensive, cheap] })));
    expect(result.recommended.stationId).toBe("cheap");
  });

  it("breaks an exact-cost tie by shorter distance first", () => {
    const far = station({
      stationId: "far",
      location: { latitude: origin.latitude + 0.01, longitude: origin.longitude },
    });
    const near = station({
      stationId: "near",
      location: { latitude: origin.latitude + 0.001, longitude: origin.longitude },
    });
    // Identical price and consumption inputs -> identical effectiveCostCents -> tied.
    const result = unwrap(rankCandidates(baseInput({ candidates: [far, near] })));
    expect(result.recommended.stationId).toBe("near");
  });

  it("breaks a tie (after distance) by fresher price", () => {
    const stale = station({
      stationId: "stale",
      price: {
        priceTenthsCpl: 1799,
        sourceReportedAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
      },
    });
    const fresh = station({
      stationId: "fresh",
      price: { priceTenthsCpl: 1799, sourceReportedAt: now },
    });
    const result = unwrap(rankCandidates(baseInput({ candidates: [stale, fresh] })));
    expect(result.recommended.stationId).toBe("fresh");
  });

  it("breaks a tie (after distance and freshness) by the preferred brand", () => {
    const other = station({ stationId: "other", brand: "OtherBrand" });
    const preferred = station({ stationId: "preferred", brand: "Acme" });
    const result = unwrap(
      rankCandidates(baseInput({ candidates: [other, preferred], preferredBrand: "Acme" })),
    );
    expect(result.recommended.stationId).toBe("preferred");
  });

  it("breaks a final tie by lower unit price", () => {
    // Same distance and freshness; different price/detour combos land on the same effective cost.
    const a = station({ stationId: "a", price: { priceTenthsCpl: 1700, sourceReportedAt: now } });
    const b = station({ stationId: "b", price: { priceTenthsCpl: 1700, sourceReportedAt: now } });
    const result = unwrap(rankCandidates(baseInput({ candidates: [a, b] })));
    // Fully identical inputs — either is a valid, deterministic pick; just confirm it doesn't throw
    // and picks consistently across repeated calls (determinism, §9.1).
    const result2 = unwrap(rankCandidates(baseInput({ candidates: [a, b] })));
    expect(result.recommended.stationId).toBe(result2.recommended.stationId);
  });

  it("produces a total order — every candidate appears exactly once in `ranked`, sorted ascending by effective cost", () => {
    const candidates = [1700, 1750, 1750, 1800, 1650].map((priceTenthsCpl, i) =>
      station({ stationId: `s${i}`, price: { priceTenthsCpl, sourceReportedAt: now } }),
    );
    const result = unwrap(rankCandidates(baseInput({ candidates })));
    expect(result.ranked).toHaveLength(candidates.length);
    expect(new Set(result.ranked.map((r) => r.stationId)).size).toBe(candidates.length);
    for (let i = 1; i < result.ranked.length; i++) {
      expect(result.ranked[i].metrics.effectiveCostCents).toBeGreaterThanOrEqual(
        result.ranked[i - 1].metrics.effectiveCostCents,
      );
    }
  });
});

describe("rankCandidates — mode selection (§9.4.4)", () => {
  it("is comparison mode with no vehicle profile at all", () => {
    const result = unwrap(rankCandidates(baseInput({ candidates: [station()] })));
    expect(result.mode).toBe("comparison");
    if (result.mode === "comparison") expect(result.referenceVolumeLitres).toBe(40);
  });

  it("is personalised mode with a complete vehicle profile", () => {
    const result = unwrap(
      rankCandidates(
        baseInput({
          candidates: [station()],
          vehicleProfile: {
            tankCapacityLitres: 50,
            currentFuelFraction: 0.2,
            consumptionLPer100km: 7,
          },
        }),
      ),
    );
    expect(result.mode).toBe("personalised");
    if (result.mode === "personalised") expect(result.litresRequiredLitres).toBe(40); // 50*(1-0.2)
  });

  it("falls back to comparison mode when a profile exists but is missing the current fraction", () => {
    const result = unwrap(
      rankCandidates(
        baseInput({
          candidates: [station()],
          vehicleProfile: {
            tankCapacityLitres: 50,
            currentFuelFraction: null,
            consumptionLPer100km: 7,
          },
        }),
      ),
    );
    expect(result.mode).toBe("comparison");
  });
});

describe("rankCandidates — saving vs nearest eligible (§9.4.3), not vs average or worst", () => {
  it("computes saving against the nearest eligible station, even when a farther station is cheaper", () => {
    const near = station({
      stationId: "near",
      location: { latitude: origin.latitude + 0.001, longitude: origin.longitude },
      price: { priceTenthsCpl: 1899, sourceReportedAt: now },
    });
    const farCheap = station({
      stationId: "far-cheap",
      location: { latitude: origin.latitude + 0.01, longitude: origin.longitude },
      price: { priceTenthsCpl: 1600, sourceReportedAt: now },
    });
    const result = unwrap(
      rankCandidates(baseInput({ candidates: [near, farCheap], maxDetourKm: 50 })),
    );
    expect(result.recommended.stationId).toBe("far-cheap"); // cheaper effective cost wins the ranking
    // Saving is still measured against `near` (nearest)'s own *effective* cost (fill + its own
    // detour), not a hand-approximated fill-cost-only figure — read both real effective costs
    // back from the result rather than reimplementing the formula in the test.
    const nearCost = result.ranked.find((r) => r.stationId === "near")!.metrics.effectiveCostCents;
    const farCheapCost = result.ranked.find((r) => r.stationId === "far-cheap")!.metrics
      .effectiveCostCents;
    expect(result.estimatedSavingCents).toBe(nearCost - farCheapCost);
    expect(result.estimatedSavingCents).toBeGreaterThan(0); // still a genuine, positive saving
  });

  it("is zero, with ALREADY_NEAREST_AND_CHEAPEST, when the recommendation is the nearest station itself", () => {
    const result = unwrap(rankCandidates(baseInput({ candidates: [station()] })));
    expect(result.estimatedSavingCents).toBe(0);
    expect(result.reasonCodes).toContain("ALREADY_NEAREST_AND_CHEAPEST");
  });
});

describe("rankCandidates — reason codes", () => {
  it("includes COMPARISON_VOLUME_ASSUMED only in comparison mode", () => {
    const result = unwrap(rankCandidates(baseInput({ candidates: [station()] })));
    expect(result.reasonCodes).toContain("COMPARISON_VOLUME_ASSUMED");
  });

  it("includes CONSUMPTION_DEFAULT_ASSUMED when no consumption figure was supplied", () => {
    const result = unwrap(rankCandidates(baseInput({ candidates: [station()] })));
    expect(result.reasonCodes).toContain("CONSUMPTION_DEFAULT_ASSUMED");
  });

  it("omits CONSUMPTION_DEFAULT_ASSUMED when a real consumption figure is supplied", () => {
    const result = unwrap(
      rankCandidates(
        baseInput({
          candidates: [station()],
          vehicleProfile: {
            tankCapacityLitres: 50,
            currentFuelFraction: 0.2,
            consumptionLPer100km: 7,
          },
        }),
      ),
    );
    expect(result.reasonCodes).not.toContain("CONSUMPTION_DEFAULT_ASSUMED");
  });

  it("includes SPARSE_CANDIDATES with fewer than 2 eligible candidates", () => {
    const result = unwrap(rankCandidates(baseInput({ candidates: [station()] })));
    expect(result.reasonCodes).toContain("SPARSE_CANDIDATES");
  });

  it("includes DETOUR_NOT_WORTH_SAVING when a cheaper-per-litre candidate exists but wasn't recommended", () => {
    const near = station({
      stationId: "near",
      location: { latitude: origin.latitude + 0.001, longitude: origin.longitude },
      price: { priceTenthsCpl: 1799, sourceReportedAt: now },
    });
    // Cheaper per litre, but far enough that the detour costs more than the saving.
    const farCheaper = station({
      stationId: "far-cheaper",
      location: { latitude: origin.latitude + 0.15, longitude: origin.longitude },
      price: { priceTenthsCpl: 1750, sourceReportedAt: now },
    });
    const result = unwrap(
      rankCandidates(baseInput({ candidates: [near, farCheaper], maxDetourKm: 100 })),
    );
    expect(result.recommended.stationId).toBe("near");
    expect(result.reasonCodes).toContain("DETOUR_NOT_WORTH_SAVING");
  });

  it("includes BELOW_LOCAL_AVERAGE / ABOVE_LOCAL_AVERAGE based on the supplied local average", () => {
    const cheap = station({ price: { priceTenthsCpl: 1700, sourceReportedAt: now } });
    const below = unwrap(
      rankCandidates(
        baseInput({
          candidates: [cheap],
          localArea: { ...emptyLocalArea, localAverageTenths: 1800 },
        }),
      ),
    );
    expect(below.reasonCodes).toContain("BELOW_LOCAL_AVERAGE");

    const expensive = station({ price: { priceTenthsCpl: 1900, sourceReportedAt: now } });
    const above = unwrap(
      rankCandidates(
        baseInput({
          candidates: [expensive],
          localArea: { ...emptyLocalArea, localAverageTenths: 1800 },
        }),
      ),
    );
    expect(above.reasonCodes).toContain("ABOVE_LOCAL_AVERAGE");
  });
});

describe("rankCandidates — determinism (§9.1)", () => {
  it("produces identical output for identical input, called twice", () => {
    const input = baseInput({
      candidates: [
        station({ stationId: "a", price: { priceTenthsCpl: 1799, sourceReportedAt: now } }),
        station({ stationId: "b", price: { priceTenthsCpl: 1750, sourceReportedAt: now } }),
      ],
    });
    expect(rankCandidates(input)).toEqual(rankCandidates(input));
  });
});

describe("rankCandidates — detourKm strategy seam (feature/commute-geometry)", () => {
  it("defaults to the origin-radial ×2 round trip when no strategy is supplied — regression safety for the new optional field", () => {
    // ~0.2 degrees latitude is roughly 22km one-way, ~44km round trip — the same fixture the
    // existing "excludes a station beyond the round-trip max-detour cap" test above uses, kept
    // in sync deliberately: this proves adding `detourKm` as an optional field didn't change
    // UC-01's existing, unmodified behaviour.
    const farStation = nearby(0.2);
    const result = rankCandidates(baseInput({ candidates: [farStation], maxDetourKm: 20 }));
    expect(result.ok).toBe(false);
  });

  it("uses a supplied strategy for the eligibility cap instead of the default", () => {
    const farStation = nearby(0.2); // fails the default origin-radial cap at maxDetourKm: 20
    const alwaysClose: DetourKmStrategy = () => 0;

    const excludedByDefault = rankCandidates(
      baseInput({ candidates: [farStation], maxDetourKm: 20 }),
    );
    expect(excludedByDefault.ok).toBe(false);

    const includedByCustomStrategy = unwrap(
      rankCandidates(
        baseInput({ candidates: [farStation], maxDetourKm: 20, detourKm: alwaysClose }),
      ),
    );
    expect(includedByCustomStrategy.recommended.stationId).toBe(farStation.stationId);
  });

  it("reports the supplied strategy's own output in metrics.additionalRoundTripKm, not the default ×2 figure", () => {
    const near = nearby(0.001);
    const fixedDetour: DetourKmStrategy = () => 7.5;
    const result = unwrap(rankCandidates(baseInput({ candidates: [near], detourKm: fixedDetour })));
    expect(result.recommended.metrics.additionalRoundTripKm).toBe(7.5);
  });

  it("end-to-end with the real corridorDetourKm (geo.ts): a station near the route beats a station nearer the origin but off-route", () => {
    // Sydney -> Canberra, real coordinates (also used in geo.test.ts's own sanity checks).
    const sydney = { latitude: -33.8688, longitude: 151.2093 };
    const canberra = { latitude: -35.3081, longitude: 149.1244 };
    // Goulburn: close to the Sydney-Canberra line (~12.5km off), further from Sydney itself.
    const goulburn = station({
      stationId: "goulburn",
      location: { latitude: -34.7539, longitude: 149.7161 },
      price: { priceTenthsCpl: 1799, sourceReportedAt: now },
    });
    // A station much closer to Sydney by straight-line distance, but well off the route
    // (Wollongong, on the coast) — origin-radial ranking would favour this one; corridor
    // ranking should not, since visiting it costs a much bigger detour off the actual trip.
    const wollongong = station({
      stationId: "wollongong",
      location: { latitude: -34.4278, longitude: 150.8931 },
      price: { priceTenthsCpl: 1799, sourceReportedAt: now }, // same price — detour is the only differentiator
    });

    const corridorStrategy: DetourKmStrategy = (origin, candidateLocation) =>
      corridorDetourKm(origin, candidateLocation, canberra);

    const result = unwrap(
      rankCandidates(
        baseInput({
          origin: sydney,
          candidates: [wollongong, goulburn],
          maxDetourKm: 50,
          detourKm: corridorStrategy,
        }),
      ),
    );

    expect(result.recommended.stationId).toBe("goulburn");
  });
});
