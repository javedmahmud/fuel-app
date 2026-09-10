import { describe, expect, it } from "vitest";
import { isWithinNswTasBounds } from "./nsw-tas-bounds";

describe("isWithinNswTasBounds", () => {
  it("accepts real NSW coordinates (Sydney CBD)", () => {
    expect(isWithinNswTasBounds({ latitude: -33.87, longitude: 151.21 })).toBe(true);
  });

  it("accepts real TAS coordinates (Hobart)", () => {
    expect(isWithinNswTasBounds({ latitude: -42.88, longitude: 147.33 })).toBe(true);
  });

  it("accepts a point in the margin just outside the mainland extent", () => {
    expect(isWithinNswTasBounds({ latitude: -27.5, longitude: 145 })).toBe(true);
  });

  it("rejects (0, 0) — a classic 'coordinates never actually set' bug signature", () => {
    expect(isWithinNswTasBounds({ latitude: 0, longitude: 0 })).toBe(false);
  });

  it("rejects a point in another country entirely (London)", () => {
    expect(isWithinNswTasBounds({ latitude: 51.5072, longitude: -0.1276 })).toBe(false);
  });

  it("rejects transposed lat/lng — a common real bug this bound exists to catch", () => {
    // Sydney's real lat/lng transposed would land near the equator off West Africa.
    expect(isWithinNswTasBounds({ latitude: 151.21, longitude: -33.87 })).toBe(false);
  });

  it("rejects a point just past each edge of the box", () => {
    expect(isWithinNswTasBounds({ latitude: -44.71, longitude: 145 })).toBe(false);
    expect(isWithinNswTasBounds({ latitude: -26.99, longitude: 145 })).toBe(false);
    expect(isWithinNswTasBounds({ latitude: -35, longitude: 139.99 })).toBe(false);
    expect(isWithinNswTasBounds({ latitude: -35, longitude: 154.71 })).toBe(false);
  });

  it("accepts exactly on each edge of the box (inclusive bounds)", () => {
    expect(isWithinNswTasBounds({ latitude: -44.7, longitude: 145 })).toBe(true);
    expect(isWithinNswTasBounds({ latitude: -27.0, longitude: 145 })).toBe(true);
    expect(isWithinNswTasBounds({ latitude: -35, longitude: 140.0 })).toBe(true);
    expect(isWithinNswTasBounds({ latitude: -35, longitude: 154.7 })).toBe(true);
  });
});
