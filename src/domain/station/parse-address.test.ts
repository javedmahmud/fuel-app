import { describe, expect, it } from "vitest";

import { parseSuburbAndPostcodeFromAddress } from "./parse-address";

describe("parseSuburbAndPostcodeFromAddress", () => {
  it("parses a comma-delimited, all-caps suburb", () => {
    expect(parseSuburbAndPostcodeFromAddress("101 HECTOR ST, SEFTON NSW 2162")).toEqual({
      suburb: "SEFTON",
      postcode: "2162",
    });
  });

  it("parses a comma-delimited, Title Case suburb", () => {
    expect(parseSuburbAndPostcodeFromAddress("651 Princes Highway, Rockdale NSW 2216")).toEqual({
      suburb: "Rockdale",
      postcode: "2216",
    });
  });

  it("parses a multi-word suburb", () => {
    expect(
      parseSuburbAndPostcodeFromAddress("60-64 Schwinghammer St, SOUTH GRAFTON NSW 2460"),
    ).toEqual({ suburb: "SOUTH GRAFTON", postcode: "2460" });
    expect(parseSuburbAndPostcodeFromAddress("104 Mill Hill Rd, Bondi Junction NSW 2022")).toEqual({
      suburb: "Bondi Junction",
      postcode: "2022",
    });
  });

  it("parses a non-NSW state code near the border, without assuming NSW", () => {
    expect(parseSuburbAndPostcodeFromAddress("86 PARRAMATTA ST, PHILLIP ACT 2606")).toEqual({
      suburb: "PHILLIP",
      postcode: "2606",
    });
  });

  it("extracts postcode even when there's no comma at all", () => {
    const result = parseSuburbAndPostcodeFromAddress("275 PACIFIC HWY Hornsby NSW 2077");
    expect(result.postcode).toBe("2077");
    // Ambiguous whether "Hornsby" or "PACIFIC HWY Hornsby" is the suburb — must not guess.
    expect(result.suburb).toBeNull();
  });

  it("declines to guess a suburb when the only comma isn't directly before it", () => {
    const result = parseSuburbAndPostcodeFromAddress("Shop 3, 1190 Miami Street Glenwood NSW 2768");
    expect(result.suburb).toBeNull();
    expect(result.postcode).toBe("2768"); // still unambiguous
  });

  it("finds the last comma-delimited segment when an earlier, unrelated comma exists", () => {
    expect(
      parseSuburbAndPostcodeFromAddress(
        "154-160 Parramatta Road & Corner Bold Street, Granville NSW 2142",
      ),
    ).toEqual({ suburb: "Granville", postcode: "2142" });
  });

  it("ignores trailing junk after the postcode", () => {
    expect(parseSuburbAndPostcodeFromAddress("52 Hill Street, Uralla, NSW  2358, AU")).toEqual({
      suburb: "Uralla",
      postcode: "2358",
    });
  });

  it("recognises a spelled-out state name, not just the abbreviation", () => {
    expect(
      parseSuburbAndPostcodeFromAddress("456, Metford Road, Metford NEW SOUTH WALES 2323"),
    ).toEqual({ suburb: "Metford", postcode: "2323" });
  });

  it("returns both null for an address with no recognisable state/postcode at all", () => {
    expect(parseSuburbAndPostcodeFromAddress("Somewhere out the back")).toEqual({
      suburb: null,
      postcode: null,
    });
  });

  it("handles an address that is just a suburb with no street component", () => {
    expect(parseSuburbAndPostcodeFromAddress("Wagga Wagga NSW 2650")).toEqual({
      // No comma at all — correctly declines rather than assuming the whole prefix is the suburb.
      suburb: null,
      postcode: "2650",
    });
  });
});
