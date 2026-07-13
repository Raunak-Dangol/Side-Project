import { describe, it, expect } from "vitest";
import { authHeader } from "./khalti";

describe("Khalti auth header", () => {
  it("sends the secret as an Authorization: Key header", () => {
    const h = authHeader();
    expect(h.Authorization).toMatch(/^Key /);
    expect(h["Content-Type"]).toBe("application/json");
  });
});
