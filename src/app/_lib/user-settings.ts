/**
 * `21_DETAILED_DESIGN.md` §21.9's Settings row: "Fuel preference, default location, vehicle
 * profile, notifications (M3), privacy/data controls. **No backend persistence until accounts
 * exist** (`11` §11.3) — lives in browser storage pre-M3." `11_AUTHENTICATION.md` §11.3: device-
 * local by design — "no personal data on our servers... a user's home location is among the most
 * sensitive things this product could hold, and not holding it is the strongest possible
 * protection." Pure read/write functions, deliberately separate from any React state — both
 * `settings-form.tsx` (writes) and `search-form.tsx` (reads, to prefill a new search) share this
 * one module rather than each rolling its own `localStorage` access.
 */

const STORAGE_KEY = "fuelIntelligence.settings.v1";

export interface VehicleProfileSettings {
  tankCapacityL: number;
  /** 0-1, matching the API's own `vehicle.currentFuelFraction` convention — the UI collects a
   * percentage and converts once, here, rather than carrying two different units around. */
  currentFuelFraction: number;
  /** `null` means "use the app's own default" (8.5 L/100km), not "zero consumption." */
  consumptionL100km: number | null;
}

export interface UserSettings {
  fuelType: string | null;
  /** Free text, same as the search form's own field — a suburb name or postcode, resolved
   * server-side on search, never geocoded or validated here. */
  defaultLocality: string | null;
  radiusKm: number | null;
  /** `null` means no saved vehicle profile at all (comparison mode stays the default). */
  vehicle: VehicleProfileSettings | null;
}

export const EMPTY_SETTINGS: UserSettings = {
  fuelType: null,
  defaultLocality: null,
  radiusKm: null,
  vehicle: null,
};

/** Never throws — private browsing, blocked site data, or a future incompatible stored shape are
 * all just "no saved settings," not an error the caller needs to handle. Shallow-merged over
 * `EMPTY_SETTINGS` so a stored object from an earlier version missing a newer field still comes
 * back with that field correctly `null` rather than `undefined`. */
export function loadSettings(): UserSettings {
  try {
    if (typeof window === "undefined") return EMPTY_SETTINGS;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return EMPTY_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<UserSettings>;
    return { ...EMPTY_SETTINGS, ...parsed };
  } catch {
    return EMPTY_SETTINGS;
  }
}

/** Returns whether the write actually succeeded (`false` in private browsing or when storage is
 * blocked/full) so the caller can tell the user honestly, rather than claiming "Saved" when
 * nothing was. */
export function saveSettings(settings: UserSettings): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
}

export function clearSettings(): boolean {
  try {
    if (typeof window === "undefined") return false;
    window.localStorage.removeItem(STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
