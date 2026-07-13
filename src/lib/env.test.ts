import { describe, it, expect } from "vitest";
import { requireEnv } from "./env";

describe("requireEnv", () => {
  it("returns the value when the var is set", () => {
    process.env.LIVE_SHOP_TEST_VAR = "present";
    expect(requireEnv("LIVE_SHOP_TEST_VAR")).toBe("present");
    delete process.env.LIVE_SHOP_TEST_VAR;
  });

  it("throws a clear error when the var is missing", () => {
    expect(() => requireEnv("LIVE_SHOP_DEFINITELY_MISSING")).toThrow(
      /Missing required environment variable: LIVE_SHOP_DEFINITELY_MISSING/,
    );
  });
});
