import { describe, it, expect } from "vitest";
import { safeRelativePath } from "./auth-redirect";

// The open-redirect defense — see auth-redirect.ts for the threat model. Every
// case here corresponds to a real bypass attempt; the fallback to "/" is what
// makes a hostile or malformed `next` unable to escape the origin.

describe("safeRelativePath", () => {
  it("passes through allowlisted in-app paths", () => {
    expect(safeRelativePath("/")).toBe("/");
    expect(safeRelativePath("/stream/abc-123")).toBe("/stream/abc-123");
    expect(safeRelativePath("/browse")).toBe("/browse");
    expect(safeRelativePath("/seller/dashboard")).toBe("/seller/dashboard");
    expect(safeRelativePath("/u/00000000-0000-0000-0000-000000000000")).toBe(
      "/u/00000000-0000-0000-0000-000000000000",
    );
  });

  it("rejects absolute URLs", () => {
    expect(safeRelativePath("https://evil.com/")).toBe("/");
    expect(safeRelativePath("http://evil.com/login")).toBe("/");
    expect(safeRelativePath("https://live-shop.app/stream/abc")).toBe("/");
  });

  it("rejects protocol-relative URLs (the classic open-redirect)", () => {
    expect(safeRelativePath("//evil.com")).toBe("/");
    expect(safeRelativePath("//evil.com/path")).toBe("/");
    expect(safeRelativePath("/\\evil.com")).toBe("/");
  });

  it("rejects backslashes", () => {
    expect(safeRelativePath("/foo\\bar")).toBe("/");
    expect(safeRelativePath("/stream\\evil")).toBe("/");
  });

  it("rejects paths outside the allowlist", () => {
    expect(safeRelativePath("/admin")).toBe("/");
    expect(safeRelativePath("/unknown")).toBe("/");
    expect(safeRelativePath("/external")).toBe("/");
  });

  it("rejects non-string / empty input", () => {
    expect(safeRelativePath(null)).toBe("/");
    expect(safeRelativePath(undefined)).toBe("/");
    expect(safeRelativePath("")).toBe("/");
    expect(safeRelativePath("   ")).toBe("/");
  });

  it("rejects control characters that could smuggle header bytes", () => {
    expect(safeRelativePath("/stream\r\nLocation: https://evil.com")).toBe("/");
    expect(safeRelativePath("/\tfoo")).toBe("/");
  });

  it("honors a custom fallback", () => {
    expect(safeRelativePath("//evil.com", "/stream/abc")).toBe("/stream/abc");
    expect(safeRelativePath(null, "/browse")).toBe("/browse");
  });

  it("preserves query strings on allowlisted paths", () => {
    expect(safeRelativePath("/stream/abc?replay=buy")).toBe(
      "/stream/abc?replay=buy",
    );
  });
});
