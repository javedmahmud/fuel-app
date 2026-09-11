"use client";

/**
 * UC-07's actual interactive surface — reads/writes `_lib/user-settings.ts`'s `localStorage`
 * record, nothing else. Loaded via `useEffect`, not a `useState` initializer, deliberately: this
 * is a Client Component that still gets an initial server render (Next.js renders client
 * components once on the server too), and the server has no `localStorage` — reading it in an
 * initializer would either throw or silently diverge between server and client markup. Loading
 * it after mount is the standard safe pattern; the one-render flash from empty to saved values
 * is an acceptable, honest tradeoff for a page whose entire reason to exist is "this data lives
 * only in your browser."
 *
 * Form fields live in one state object, set with a single `setState` call inside the loading
 * effect (not one call per field) — the project's `react-hooks/set-state-in-effect` lint rule
 * flags multiple sequential `setState` calls in one effect body as cascading-render risk, and one
 * object is also just a more honest model of "this is all one record loaded together."
 */
import { useEffect, useId, useState } from "react";

import type { FuelTypeSummary } from "../../infrastructure/repositories/fuel-type-repository";
import {
  clearSettings,
  loadSettings,
  saveSettings,
  type UserSettings,
} from "../_lib/user-settings";
import styles from "./search-form.module.css";
import settingsStyles from "./settings-form.module.css";

const MAX_RADIUS_KM = 50;

interface FormState {
  fuelType: string | null;
  defaultLocality: string;
  radiusKm: number | null;
  showVehicle: boolean;
  tankCapacityL: string;
  currentFuelPercent: string;
  consumptionL100km: string;
}

const BLANK_FORM: FormState = {
  fuelType: null,
  defaultLocality: "",
  radiusKm: null,
  showVehicle: false,
  tankCapacityL: "",
  currentFuelPercent: "",
  consumptionL100km: "",
};

function toFormState(settings: UserSettings): FormState {
  return {
    fuelType: settings.fuelType,
    defaultLocality: settings.defaultLocality ?? "",
    radiusKm: settings.radiusKm,
    showVehicle: settings.vehicle !== null,
    tankCapacityL: settings.vehicle ? String(settings.vehicle.tankCapacityL) : "",
    currentFuelPercent: settings.vehicle
      ? String(Math.round(settings.vehicle.currentFuelFraction * 100))
      : "",
    consumptionL100km:
      settings.vehicle?.consumptionL100km != null ? String(settings.vehicle.consumptionL100km) : "",
  };
}

export function SettingsForm({ fuelTypes }: { fuelTypes: FuelTypeSummary[] }) {
  const formId = useId();

  // `null` doubles as "not loaded from localStorage yet" — one state slot instead of a separate
  // `loaded` boolean, so the loading effect only ever needs a single setState call.
  const [form, setForm] = useState<FormState | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  useEffect(() => {
    // `set-state-in-effect` is right in general (the docs it links to argue for deriving state
    // during render, or subscribing via useSyncExternalStore for an external store), but there is
    // no render-time equivalent for a one-shot "hydrate from localStorage after mount" read: the
    // server has no localStorage at all, so reading it during render — the alternative the rule
    // wants — isn't available here the way it would be for a value derivable from props/state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm(toFormState(loadSettings()));
  }, []);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));
  }

  function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!form) return;

    const settings: UserSettings = {
      fuelType: form.fuelType,
      defaultLocality: form.defaultLocality.trim() || null,
      radiusKm: form.radiusKm,
      vehicle:
        form.showVehicle && form.tankCapacityL && form.currentFuelPercent
          ? {
              tankCapacityL: Number(form.tankCapacityL),
              currentFuelFraction: Number(form.currentFuelPercent) / 100,
              consumptionL100km: form.consumptionL100km ? Number(form.consumptionL100km) : null,
            }
          : null,
    };

    const ok = saveSettings(settings);
    setSavedMessage(
      ok ? "Saved on this device." : "Couldn't save — check your browser's storage settings.",
    );
  }

  function handleClear() {
    if (!window.confirm("Clear all saved settings on this device? This can't be undone.")) {
      return;
    }
    clearSettings();
    setForm(BLANK_FORM);
    setSavedMessage("Cleared.");
  }

  if (!form) {
    // Avoids rendering interactive defaults that would immediately jump once localStorage loads.
    return null;
  }

  return (
    <form className={styles.console} onSubmit={handleSave}>
      <section>
        <p className={settingsStyles.groupTitle}>Search defaults</p>

        <p className={styles.fieldLabel}>Default fuel type</p>
        <div className={styles.chipset} role="group" aria-label="Default fuel type">
          {fuelTypes.map((ft) => (
            <button
              type="button"
              key={ft.id}
              className={styles.chip}
              aria-pressed={form.fuelType === ft.sourceCode}
              onClick={() =>
                set("fuelType", form.fuelType === ft.sourceCode ? null : ft.sourceCode)
              }
            >
              {ft.displayName}
            </button>
          ))}
        </div>

        <label className={settingsStyles.fieldLabelSpaced} htmlFor={`${formId}-locality`}>
          Default location
        </label>
        <input
          id={`${formId}-locality`}
          className={styles.textInput}
          type="text"
          placeholder="e.g. Chippendale NSW, or 2008 — leave blank to use your location each time"
          value={form.defaultLocality}
          onChange={(e) => set("defaultLocality", e.target.value)}
        />

        <div className={settingsStyles.radiusTop}>
          <span className={settingsStyles.fieldLabelSpaced}>Default search radius</span>
          <span className={styles.radiusVal}>{form.radiusKm ?? 5} km</span>
        </div>
        <input
          type="range"
          min={1}
          max={MAX_RADIUS_KM}
          value={form.radiusKm ?? 5}
          onChange={(e) => set("radiusKm", Number(e.target.value))}
          aria-label="Default search radius in kilometres"
        />
      </section>

      <section>
        <p className={settingsStyles.groupTitle}>Vehicle profile — optional</p>
        <button
          type="button"
          className={styles.vehicleToggle}
          onClick={() => set("showVehicle", !form.showVehicle)}
          aria-expanded={form.showVehicle}
        >
          {form.showVehicle ? "− Remove saved vehicle" : "+ Save a vehicle profile"}
        </button>
        {!form.showVehicle && (
          <p className={styles.assumeNote}>
            Without one, searches rank a 40 L reference fill and show results as a price difference,
            not a total.
          </p>
        )}
        {form.showVehicle && (
          <div className={styles.vehicleFields}>
            <label className={styles.localityLabel} htmlFor={`${formId}-tank`}>
              Tank capacity (L)
            </label>
            <input
              id={`${formId}-tank`}
              className={styles.textInput}
              type="number"
              min={1}
              value={form.tankCapacityL}
              onChange={(e) => set("tankCapacityL", e.target.value)}
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
              value={form.currentFuelPercent}
              onChange={(e) => set("currentFuelPercent", e.target.value)}
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
              value={form.consumptionL100km}
              onChange={(e) => set("consumptionL100km", e.target.value)}
            />
          </div>
        )}
      </section>

      <section>
        <p className={settingsStyles.groupTitle}>Notifications</p>
        <div className={settingsStyles.settingsCard}>
          <div className={settingsStyles.settingsRow}>
            <div>
              <div className={settingsStyles.settingsRowLabel}>Price alerts</div>
              <div className={settingsStyles.settingsRowSub}>
                Needs accounts — not available yet
              </div>
            </div>
            <div className={settingsStyles.toggleDisabled} aria-disabled="true" />
          </div>
        </div>
      </section>

      {savedMessage && <p className={settingsStyles.savedMessage}>{savedMessage}</p>}

      <button type="submit" className={styles.cta}>
        Save
      </button>

      <button type="button" className={settingsStyles.dangerLink} onClick={handleClear}>
        Clear my data on this device
      </button>
    </form>
  );
}
