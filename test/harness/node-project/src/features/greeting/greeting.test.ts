import { describe, expect, it } from "vitest";
import { greet } from "./greeting";

describe("greet", () => {
  it("greets the given name", () => {
    expect(greet("Ada")).toBe("Hello, Ada!");
  });

  it("falls back to world for a blank name", () => {
    expect(greet("  ")).toBe("Hello, world!");
  });
});
