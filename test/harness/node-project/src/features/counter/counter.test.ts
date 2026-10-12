import { describe, expect, it } from "vitest";
import { increment } from "./counter";

describe("increment", () => {
  it("adds one by default", () => {
    expect(increment(0)).toBe(1);
  });

  it("adds the given step", () => {
    expect(increment(2, 5)).toBe(7);
  });
});
