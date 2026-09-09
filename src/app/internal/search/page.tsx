/**
 * `03_DELIVERY_ROADMAP.md` §3.3 / `20_SPRINT_PLAN.md` §20.6: "A deliberately plain internal
 * results page — no design work." A full screen design already exists (`21_DETAILED_DESIGN.md`
 * §21.9) but is deliberately not used here — this stays a debugging tool that proves the real
 * search -> rank -> persist pipeline (`search-service.ts`) works end to end, not a preview of
 * the product. Plain semantic HTML only, no CSS of its own.
 *
 * A GET form submitting back to this same URL — the simplest way to make a page's own state
 * shareable/bookmarkable/back-button-safe without any client JS, and Next's own recommended use
 * of `searchParams` ("use... when you need search parameters to load data for the page").
 */
import { runSearch, type SearchOutcome } from "../../../application/search-service";
import { getDb } from "../../../infrastructure/db/client";
import { loadActiveFuelTypeCodeToId } from "../../../infrastructure/repositories/fuel-type-repository";

export const dynamic = "force-dynamic"; // never cache a search result

type RawParams = Record<string, string | string[] | undefined>;

function asString(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asFloat(value: string | string[] | undefined): number | undefined {
  const s = asString(value);
  if (!s) return undefined;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : undefined;
}

export default async function InternalSearchPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const db = getDb();

  const fuelTypeCodeToId = await loadActiveFuelTypeCodeToId(db);
  const fuelTypeCodes = [...fuelTypeCodeToId.keys()].sort();

  const latitude = asFloat(params.latitude);
  const longitude = asFloat(params.longitude);
  const fuelTypeCode = asString(params.fuelTypeCode);
  const maxDetourKm = asFloat(params.maxDetourKm);
  const tankCapacityLitres = asFloat(params.tankCapacityLitres);
  const currentFuelFraction = asFloat(params.currentFuelFraction);
  const consumptionLPer100km = asFloat(params.consumptionLPer100km);
  const preferredBrand = asString(params.preferredBrand) || undefined;

  const submitted = params.submitted === "1";
  const hasRequiredFields =
    latitude !== undefined &&
    longitude !== undefined &&
    !!fuelTypeCode &&
    maxDetourKm !== undefined;

  let outcome: SearchOutcome | undefined;
  let searchError: string | undefined;
  if (submitted) {
    if (!hasRequiredFields) {
      searchError = "Latitude, longitude, fuel type, and max detour km are all required.";
    } else {
      const hasAnyVehicleField =
        tankCapacityLitres !== undefined ||
        currentFuelFraction !== undefined ||
        consumptionLPer100km !== undefined;
      const result = await runSearch(db, {
        origin: { latitude, longitude },
        maxDetourKm,
        fuelTypeCode,
        vehicleProfile: hasAnyVehicleField
          ? {
              tankCapacityLitres: tankCapacityLitres ?? null,
              currentFuelFraction: currentFuelFraction ?? null,
              consumptionLPer100km: consumptionLPer100km ?? null,
            }
          : null,
        preferredBrand,
        now: new Date(),
      });
      if (result.ok) {
        outcome = result.value;
      } else {
        searchError = `Search failed: ${result.error.type}`;
      }
    }
  }

  return (
    <div>
      <h1>Internal search (debug)</h1>
      <p>
        §3.3: deliberately plain, no design work — proves the search → rank → persist pipeline works
        end to end. Not a preview of the product.
      </p>

      <form method="GET">
        <input type="hidden" name="submitted" value="1" />
        <p>
          <label>
            Latitude{" "}
            <input name="latitude" defaultValue={asString(params.latitude) ?? "-33.87"} size={12} />
          </label>{" "}
          <label>
            Longitude{" "}
            <input
              name="longitude"
              defaultValue={asString(params.longitude) ?? "151.21"}
              size={12}
            />
          </label>
        </p>
        <p>
          <label>
            Fuel type{" "}
            <select name="fuelTypeCode" defaultValue={fuelTypeCode ?? ""}>
              <option value="">-- select --</option>
              {fuelTypeCodes.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </select>
          </label>{" "}
          <label>
            Max detour, round-trip km{" "}
            <input
              name="maxDetourKm"
              defaultValue={asString(params.maxDetourKm) ?? "20"}
              size={6}
            />
          </label>
        </p>
        <fieldset>
          <legend>
            Optional — vehicle profile (personalised mode; leave blank for comparison mode)
          </legend>
          <p>
            <label>
              Tank capacity (L){" "}
              <input
                name="tankCapacityLitres"
                defaultValue={asString(params.tankCapacityLitres) ?? ""}
                size={6}
              />
            </label>{" "}
            <label>
              Current fuel fraction (0–1){" "}
              <input
                name="currentFuelFraction"
                defaultValue={asString(params.currentFuelFraction) ?? ""}
                size={6}
              />
            </label>{" "}
            <label>
              Consumption (L/100km){" "}
              <input
                name="consumptionLPer100km"
                defaultValue={asString(params.consumptionLPer100km) ?? ""}
                size={6}
              />
            </label>
          </p>
        </fieldset>
        <p>
          <label>
            Preferred brand (optional, tie-break only){" "}
            <input name="preferredBrand" defaultValue={asString(params.preferredBrand) ?? ""} />
          </label>
        </p>
        <button type="submit">Search</button>
      </form>

      <hr />

      {searchError && <p style={{ color: "red" }}>{searchError}</p>}
      {outcome && <ResultView outcome={outcome} />}
    </div>
  );
}

function ResultView({ outcome }: { outcome: SearchOutcome }) {
  const { result, recommendationLogId } = outcome;
  const { recommended } = result;

  return (
    <div>
      <h2>Recommendation</h2>
      <p>
        recommendation_log id: <code>{recommendationLogId}</code> · engine version:{" "}
        <code>{result.engineVersion}</code> · mode: <strong>{result.mode}</strong>{" "}
        {result.mode === "comparison"
          ? `(reference volume ${result.referenceVolumeLitres} L)`
          : `(${result.litresRequiredLitres.toFixed(1)} L required)`}
      </p>
      <p>confidence: {result.confidence}</p>
      <p>
        local-area rank percentile:{" "}
        {result.rankPercentile === null ? "n/a" : `${Math.round(result.rankPercentile * 100)}%`}
      </p>
      <p>local-area trend: {result.trendDirection}</p>
      <p>
        estimated saving vs. nearest eligible station:{" "}
        {(result.estimatedSavingCents / 100).toFixed(2)} c
      </p>
      <p>reason codes: {result.reasonCodes.join(", ")}</p>

      <h3>Recommended station</h3>
      <ul>
        <li>station id: {recommended.stationId}</li>
        <li>brand: {recommended.brand ?? "unknown"}</li>
        <li>distance: {recommended.metrics.distanceKm.toFixed(2)} km</li>
        <li>price: {(recommended.metrics.priceTenthsCpl / 10).toFixed(1)} c/L</li>
        <li>effective cost: ${(recommended.metrics.effectiveCostCents / 100).toFixed(2)}</li>
      </ul>

      <h3>All eligible candidates, ranked</h3>
      <table border={1} cellPadding={4}>
        <thead>
          <tr>
            <th>#</th>
            <th>station id</th>
            <th>brand</th>
            <th>distance (km)</th>
            <th>price (c/L)</th>
            <th>effective cost ($)</th>
          </tr>
        </thead>
        <tbody>
          {result.ranked.map((candidate, i) => (
            <tr key={candidate.stationId}>
              <td>{i + 1}</td>
              <td>{candidate.stationId}</td>
              <td>{candidate.brand ?? "unknown"}</td>
              <td>{candidate.metrics.distanceKm.toFixed(2)}</td>
              <td>{(candidate.metrics.priceTenthsCpl / 10).toFixed(1)}</td>
              <td>{(candidate.metrics.effectiveCostCents / 100).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
