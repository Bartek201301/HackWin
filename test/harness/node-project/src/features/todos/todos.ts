import type { Feature } from "../../shared/feature";

export function addTodo(items: readonly string[], text: string): string[] {
  const trimmed = text.trim();
  return trimmed ? [...items, trimmed] : [...items];
}

export const todos: Feature = {
  title: "Todos",
  mount(root) {
    let items: string[] = [];
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.className = "w-full rounded border px-2 py-1";
    input.placeholder = "Add a todo";
    const list = document.createElement("ul");
    list.className = "mt-2 list-disc pl-5";
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      items = addTodo(items, input.value);
      input.value = "";
      list.replaceChildren(
        ...items.map((item) => {
          const li = document.createElement("li");
          li.textContent = item;
          return li;
        }),
      );
    });
    form.append(input);
    root.append(form, list);
  },
};
