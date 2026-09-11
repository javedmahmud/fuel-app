"use client";

/**
 * The one client-side piece of the Commute Mode screen (`21_DETAILED_DESIGN.md` §21.9's Stack
 * section: "Client components only where genuinely interactive"), the last of the three Sprint 5
 * branches (`20_SPRINT_PLAN.md` §20.8). Deliberate near-mirror of `search-form.tsx`: origin uses
 * the identical "Use my location" + suburb/postcode-text-fallback pattern (there's no reason a
 * commute's starting point should collect location any differently than a nearby search's does);
 * destination has no geolocation equivalent — there's no "use my destination" browser API — so
 * it's always a plain text field, resolved the same way on the server
 * (`resolve-locality-or-postcode.ts`, shared with `handle-search-request.ts`).
 *
 * Submitting just builds a `/commute` query string and navigates — real validation and resolution
 * happens server-side in `handleCommuteRequest`, matching `search-form.tsx`'s own "the form
 * doesn't validate, the server does" division of labour. `/commute` is a single combined
 * form-and-results route (§21.9 lists Commute Mode as one screen, not a Home/Results pair like
 * UC-01), so this form re-renders pre-filled from the current URL when results are already
 * showing, letting a driver adjust one field and resubmit without retyping everything.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import type { FuelTypeSummary } from "../../infrastructure/repositories/fuel-type-repository";
import { loadSettings } from "../_lib/user-settings";
import styles from "./commute-form.module.css";

const MAX_DETOUR_KM = 50; // matches handle-commute-request.ts's own MAX_DETOUR_KM cap
const DEFAULT_MAX_DETOUR_KM = 20;
const PREFERRED_DEFAULT_FUEL_CODE = "U91";

type GeoStatus = "idle" | "locating" | "found" | "denied" | "unavailable";

export function CommuteForm({
  fuelTypes,
  initial,
}: {
  fuelTypes: FuelTypeSummary[];
  /** Pre-fill from the current URL's query params, so editing one field and resubmitting doesn't
   * require retyping everything — `undefined` fields just fall back to this component's own
   * defaults, same as a first-ever visit. */
  initial: {
    originLocality: string;
    destLocality: string;
    fuelType: string;
    maxDetourKm: number | undefined;
  };
}) {
  const router = useRouter();
  const formId = useId();

  const [originCoords, setOriginCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  const [originLocality, setOriginLocality] = useState(initial.originLocality);
  const [destLocality, setDestLocality] = useState(initial.destLocality);
  const [fuelType, setFuelType] = useState(
    () =>
      (initial.fuelType && fuelTypes.some((f) => f.sourceCode === initial.fuelType)
        ? initial.fuelType
        : undefined) ??
      fuelTypes.find((f) => f.sourceCode === PREFERRED_DEFAULT_FUEL_CODE)?.sourceCode ??
      fuelTypes[0]?.sourceCode ??
      "",
  );
  const [maxDetourKm, setMaxDetourKm] = useState(initial.maxDetourKm ?? DEFAULT_MAX_DETOUR_KM);
  const [showVehicle, setShowVehicle] = useState(false);
  const [tankCapacityL, setTankCapacityL] = useState("");
  const [currentFuelPercent, setCurrentFuelPercent] = useState("");
  const [consumptionL100km, setConsumptionL100km] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(
    () => {
      // Same justified exception as search-form.tsx's own loading effect — a one-shot hydrate
      // from localStorage (unavailable during this Client Component's server render) after
      // mount, never in a useState initializer. Only fuel type and vehicle profile are prefilled
      // from Settings here, deliberately not a saved "max detour": Settings' radiusKm plays that
      // role for nearby search, but a route detour cap is a genuinely different quantity with no
      // saved default yet — see handle-commute-request.ts's own note that this endpoint requires
      // maxDetourKm precisely because UC-02 has no sensible universal default for it. Only
      // applied when the URL didn't already supply a value (`initial.fuelType` empty) — an
      // in-progress edit (e.g. a resubmission) always wins over a saved default.
      /* eslint-disable react-hooks/set-state-in-effect */
      if (!initial.fuelType) {
        const settings = loadSettings();
        if (settings.fuelType && fuelTypes.some((f) => f.sourceCode === settings.fuelType)) {
          setFuelType(settings.fuelType);
        }
        if (settings.vehicle) {
          setShowVehicle(true);
          setTankCapacityL(String(settings.vehicle.tankCapacityL));
          setCurrentFuelPercent(String(Math.round(settings.vehicle.currentFuelFraction * 100)));
          if (settings.vehicle.consumptionL100km !== null) {
            setConsumptionL100km(String(settings.vehicle.consumptionL100km));
          }
        }
      }
      /* eslint-enable react-hooks/set-state-in-effect */
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setGeoStatus("unavailable");
      return;
    }
    setGeoStatus("locating");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setOriginCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
        setGeoStatus("found");
        setFormError(null);
      },
      () => {
        setGeoStatus("denied");
      },
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!originCoords && originLocality.trim() === "") {
      setFormError("Use your location, or enter where you're starting from.");
      return;
    }
    if (destLocality.trim() === "") {
      setFormError("Enter where you're headed.");
      return;
    }
    if (!fuelType) {
      setFormError("Choose a fuel type.");
      return;
    }
    setFormError(null);

    const params = new URLSearchParams();
    if (originCoords) {
      params.set("originLat", String(originCoords.lat));
      params.set("originLng", String(originCoords.lng));
    } else {
      params.set("originLocality", originLocality.trim());
    }
    params.set("destLocality", destLocality.trim());
    params.set("fuelType", fuelType);
    params.set("maxDetourKm", String(maxDetourKm));

    if (showVehicle) {
      if (tankCapacityL) params.set("vehicle.tankCapacityL", tankCapacityL);
      if (currentFuelPercent) {
        params.set("vehicle.currentFuelFraction", String(Number(currentFuelPercent) / 100));
      }
      if (consumptionL100km) params.set("consumptionL100km", consumptionL100km);
    }

    router.push(`/commute?${params.toString()}`);
  }

  return (
    <form className={styles.console} onSubmit={handleSubmit}>
      <div>
        <p className={styles.fieldLabel}>Starting from</p>
        <div className={styles.locationCard}>
          <button
            type="button"
            className={styles.locationButton}
            onClick={useMyLocation}
            disabled={geoStatus === "locating"}
          >
            {geoStatus === "locating"
              ? "Finding you…"
              : geoStatus === "found"
                ? "✓ Using your location"
                : "📍 Use my location"}
          </button>
          {geoStatus === "denied" && (
            <p className={styles.geoNote}>
              Couldn&apos;t use your location — enter a suburb or postcode below instead.
            </p>
          )}
          {geoStatus === "unavailable" && (
            <p className={styles.geoNote}>
              Location isn&apos;t available in this browser — enter a suburb or postcode below.
            </p>
          )}
          <label className={styles.localityLabel} htmlFor={`${formId}-origin`}>
            {originCoords ? "Or start somewhere else" : "Suburb or postcode"}
          </label>
          <input
            id={`${formId}-origin`}
            className={styles.textInput}
            type="text"
            placeholder="e.g. Sydney NSW"
            value={originLocality}
            onChange={(e) => {
              setOriginLocality(e.target.value);
              if (e.target.value.trim() !== "") {
                setOriginCoords(null);
                setGeoStatus("idle");
              }
            }}
          />
        </div>
      </div>

      <div>
        <label className={styles.fieldLabel} htmlFor={`${formId}-destination`}>
          Heading to
        </label>
        <input
          id={`${formId}-destination`}
          className={styles.textInput}
          type="text"
          placeholder="e.g. Canberra ACT, or 2600"
          value={destLocality}
          onChange={(e) => setDestLocality(e.target.value)}
        />
      </div>

      <div>
        <label className={styles.fieldLabel} htmlFor={`${formId}-fuelType`}>
          Fuel type
        </label>
        <select
          id={`${formId}-fuelType`}
          className={styles.select}
          value={fuelType}
          onChange={(e) => setFuelType(e.target.value)}
        >
          {fuelTypes.map((ft) => (
            <option key={ft.id} value={ft.sourceCode}>
              {ft.displayName}
            </option>
          ))}
        </select>
      </div>

      <div>
        <div className={styles.radiusTop}>
          <span className={styles.fieldLabel}>Max detour off your route</span>
          <span className={styles.radiusVal}>{maxDetourKm} km</span>
        </div>
        <input
          type="range"
          min={1}
          max={MAX_DETOUR_KM}
          value={maxDetourKm}
          onChange={(e) => setMaxDetourKm(Number(e.target.value))}
          aria-label="Maximum detour off your route, in kilometres"
        />
        <p className={styles.assumeNote}>
          An estimate, not a real route — based on a straight line between your two points, not
          roads or traffic.
        </p>
      </div>

      <div>
        <button
          type="button"
          className={styles.vehicleToggle}
          onClick={() => setShowVehicle((v) => !v)}
          aria-expanded={showVehicle}
        >
          {showVehicle ? "− Remove my vehicle details" : "+ Add my vehicle for a precise cost"}
        </button>
        {!showVehicle && (
          <p className={styles.assumeNote}>
            Ranking a 40 L reference fill unless you add a vehicle — results are shown as a price
            difference, not a total.
          </p>
        )}
        {showVehicle && (
          <div className={styles.vehicleFields}>
            <label className={styles.localityLabel} htmlFor={`${formId}-tank`}>
              Tank capacity (L)
            </label>
            <input
              id={`${formId}-tank`}
              className={styles.textInput}
              type="number"
              min={1}
              value={tankCapacityL}
              onChange={(e) => setTankCapacityL(e.target.value)}
            />
            <label className={styles.localityLabel} htmlFor={`${formId}-fraction`}>
              Current fuel level (%)
            </label>
            <input
              id={`${formId}-fraction`}
              className={styles.textInput}
              type="number"
              min={0}
              max={100}
              value={currentFuelPercent}
              onChange={(e) => setCurrentFuelPercent(e.target.value)}
            />
            <label className={styles.localityLabel} htmlFor={`${formId}-consumption`}>
              Consumption (L/100km) — optional, defaults to 8.5
            </label>
            <input
              id={`${formId}-consumption`}
              className={styles.textInput}
              type="number"
              min={0.1}
              step={0.1}
              value={consumptionL100km}
              onChange={(e) => setConsumptionL100km(e.target.value)}
            />
          </div>
        )}
      </div>

      {formError && <p className={styles.formError}>{formError}</p>}

      <button type="submit" className={styles.cta}>
        Find best price on my route →
      </button>
    </form>
  );
}
