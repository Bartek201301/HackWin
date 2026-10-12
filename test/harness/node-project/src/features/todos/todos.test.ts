import { describe, expect, it } from "vitest";
import { addTodo } from "./todos";

describe("addTodo", () => {
  it("appends the trimmed text", () => {
    expect(addTodo(["a"], "  b  ")).toEqual(["a", "b"]);
  });

  it("ignores blank text", () => {
    expect(addTodo(["a"], "   ")).toEqual(["a"]);
  });

  it("does not change the input list", () => {
    const items = ["a"];
    addTodo(items, "b");
    expect(items).toEqual(["a"]);
  });
});
