"use client";

/**
 * The one client-side piece of the Home screen (`21_DETAILED_DESIGN.md` §21.9's Stack section:
 * "Client components only where genuinely interactive: the search form, the browser geolocation
 * prompt"). Two independent, always-visible ways to give a location — "Use my location" and a
 * plain suburb/postcode text field — never one gated behind the other failing, per the degraded-
 * states table: "Geolocation denied | Falls back to suburb/postcode text entry — never a dead
 * end." Submitting just builds a `/search` query string and navigates; all real validation and
 * resolution happens server-side in `handleSearchRequest`, same as any other caller of that API.
 */
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";

import type { FuelTypeSummary } from "../../infrastructure/repositories/fuel-type-repository";
import { loadSettings } from "../_lib/user-settings";
import styles from "./search-form.module.css";

const DEFAULT_RADIUS_KM = 5;
const MAX_RADIUS_KM = 50;
const PREFERRED_DEFAULT_FUEL_CODE = "U91";

type GeoStatus = "idle" | "locating" | "found" | "denied" | "unavailable";

export function SearchForm({ fuelTypes }: { fuelTypes: FuelTypeSummary[] }) {
  const router = useRouter();
  const formId = useId();

  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>("idle");
  const [locality, setLocality] = useState("");
  const [fuelType, setFuelType] = useState(
    () =>
      fuelTypes.find((f) => f.sourceCode === PREFERRED_DEFAULT_FUEL_CODE)?.sourceCode ??
      fuelTypes[0]?.sourceCode ??
      "",
  );
  const [radiusKm, setRadiusKm] = useState(DEFAULT_RADIUS_KM);
  const [showVehicle, setShowVehicle] = useState(false);
  const [tankCapacityL, setTankCapacityL] = useState("");
  const [currentFuelPercent, setCurrentFuelPercent] = useState("");
  const [consumptionL100km, setConsumptionL100km] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(
    () => {
      // Saved settings (feature/settings-screen) only ever exist in localStorage, unavailable
      // during the server render this Client Component also gets — reading them here (after
      // mount) rather than in a useState initializer avoids a hydration mismatch, the standard
      // reason this pattern exists. There's no render-time equivalent for a one-shot "hydrate
      // from an external store after mount" read the way there would be for a value derivable
      // from props/state, so — same justified exception as settings-form.tsx's own loading
      // effect — the setState calls below are deliberate, not something to restructure around.
      // Each field only overrides its own already-computed default, so this never clobbers state
      // a user could plausibly have touched before mount finishes.
      /* eslint-disable react-hooks/set-state-in-effect */
      const settings = loadSettings();
      if (settings.fuelType && fuelTypes.some((f) => f.sourceCode === settings.fuelType)) {
        setFuelType(settings.fuelType);
      }
      if (settings.radiusKm !== null) setRadiusKm(settings.radiusKm);
      if (settings.defaultLocality) setLocality(settings.defaultLocality);
      if (settings.vehicle) {
        setShowVehicle(true);
        setTankCapacityL(String(settings.vehicle.tankCapacityL));
        setCurrentFuelPercent(String(Math.round(settings.vehicle.currentFuelFraction * 100)));
        if (settings.vehicle.consumptionL100km !== null) {
          setConsumptionL100km(String(settings.vehicle.consumptionL100km));
        }
      }
      /* eslint-enable react-hooks/set-state-in-effect */
    },
    // fuelTypes is the server-provided list, stable for the component's lifetime; re-running
    // this on every render would keep re-applying saved settings over whatever the driver has
    // since typed.
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
        setCoords({ lat: position.coords.latitude, lng: position.coords.longitude });
        setGeoStatus("found");
        setFormError(null);
      },
      () => {
        // Denied or unavailable — the suburb/postcode field below is already visible and
        // equally functional, so this is never a dead end, just an unused shortcut.
        setGeoStatus("denied");
      },
    );
  }

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();

    if (!coords && locality.trim() === "") {
      setFormError("Use your location, or enter a suburb or postcode.");
      return;
    }
    if (!fuelType) {
      setFormError("Choose a fuel type.");
      return;
    }
    setFormError(null);

    const params = new URLSearchParams();
    if (coords) {
      params.set("lat", String(coords.lat));
      params.set("lng", String(coords.lng));
    } else {
      params.set("locality", locality.trim());
    }
    params.set("fuelType", fuelType);
    params.set("radiusKm", String(radiusKm));

    if (showVehicle) {
      if (tankCapacityL) params.set("vehicle.tankCapacityL", tankCapacityL);
      if (currentFuelPercent) {
        params.set("vehicle.currentFuelFraction", String(Number(currentFuelPercent) / 100));
      }
      if (consumptionL100km) params.set("consumptionL100km", consumptionL100km);
    }

    router.push(`/search?${params.toString()}`);
  }

  return (
    <form className={styles.console} onSubmit={handleSubmit}>
      <div>
        <p className={styles.fieldLabel}>Searching near</p>
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
          <label className={styles.localityLabel} htmlFor={`${formId}-locality`}>
            {coords ? "Or search a different area" : "Suburb or postcode"}
          </label>
          <input
            id={`${formId}-locality`}
            className={styles.textInput}
            type="text"
            placeholder="e.g. Chippendale NSW, or 2008"
            value={locality}
            onChange={(e) => {
              setLocality(e.target.value);
              if (e.target.value.trim() !== "") {
                // Typing a locality supersedes an already-found location, so submit uses
                // whichever the driver touched most recently.
                setCoords(null);
                setGeoStatus("idle");
              }
            }}
          />
        </div>
      </div>

      <div>
        <p className={styles.fieldLabel}>Fuel type</p>
        <div className={styles.chipset} role="group" aria-label="Fuel type">
          {fuelTypes.map((ft) => (
            <button
              type="button"
              key={ft.id}
              className={styles.chip}
              aria-pressed={fuelType === ft.sourceCode}
              onClick={() => setFuelType(ft.sourceCode)}
            >
              {ft.displayName}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className={styles.radiusTop}>
          <span className={styles.fieldLabel}>Search radius</span>
          <span className={styles.radiusVal}>{radiusKm} km</span>
        </div>
        <input
          type="range"
          min={1}
          max={MAX_RADIUS_KM}
          value={radiusKm}
          onChange={(e) => setRadiusKm(Number(e.target.value))}
          aria-label="Search radius in kilometres"
        />
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
        Find best price →
      </button>
    </form>
  );
}
