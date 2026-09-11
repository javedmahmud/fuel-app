import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearSettings,
  EMPTY_SETTINGS,
  loadSettings,
  saveSettings,
  type UserSettings,
} from "./user-settings";

/** No jsdom in this project (vitest.config.mts runs the plain "node" environment) — these
 * functions only ever touch `window.localStorage` as a plain object, so a minimal in-memory stub
 * is enough to exercise them without pulling in a browser DOM for one small module. */
function stubLocalStorage() {
  const store = new Map<string, string>();
  const fakeStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  (globalThis as unknown as { window: unknown }).window = { localStorage: fakeStorage };
  return fakeStorage;
}

describe("user-settings", () => {
  beforeEach(() => {
    stubLocalStorage();
  });

  afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
  });

  it("returns EMPTY_SETTINGS when nothing has ever been saved", () => {
    expect(loadSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("round-trips a full settings object", () => {
    const settings: UserSettings = {
      fuelType: "U91",
      defaultLocality: "Chatswood NSW 2067",
      radiusKm: 10,
      vehicle: { tankCapacityL: 50, currentFuelFraction: 0.25, consumptionL100km: 7.5 },
    };
    expect(saveSettings(settings)).toBe(true);
    expect(loadSettings()).toEqual(settings);
  });

  it("clearSettings removes a saved object, reverting to EMPTY_SETTINGS", () => {
    saveSettings({ ...EMPTY_SETTINGS, fuelType: "U91" });
    expect(clearSettings()).toBe(true);
    expect(loadSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("fills in a missing field with EMPTY_SETTINGS' value, for forward compatibility with an older stored shape", () => {
    stubLocalStorage();
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem(
      "fuelIntelligence.settings.v1",
      JSON.stringify({ fuelType: "P98" }),
    );
    expect(loadSettings()).toEqual({ ...EMPTY_SETTINGS, fuelType: "P98" });
  });

  it("returns EMPTY_SETTINGS rather than throwing on corrupted stored JSON", () => {
    (globalThis as unknown as { window: { localStorage: Storage } }).window.localStorage.setItem(
      "fuelIntelligence.settings.v1",
      "{not valid json",
    );
    expect(loadSettings()).toEqual(EMPTY_SETTINGS);
  });

  it("never throws when window is unavailable (server-side call)", () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(loadSettings()).toEqual(EMPTY_SETTINGS);
    expect(saveSettings(EMPTY_SETTINGS)).toBe(false);
    expect(clearSettings()).toBe(false);
  });
});
