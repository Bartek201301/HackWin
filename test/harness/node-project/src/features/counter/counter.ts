import type { Feature } from "../../shared/feature";

export function increment(count: number, step = 1): number {
  return count + step;
}

export const counter: Feature = {
  title: "Counter",
  mount(root) {
    let count = 0;
    const button = document.createElement("button");
    button.className = "rounded bg-indigo-600 px-3 py-1 text-white";
    const render = () => (button.textContent = `Clicked ${count} times`);
    button.addEventListener("click", () => {
      count = increment(count);
      render();
    });
    render();
    root.append(button);
  },
};
