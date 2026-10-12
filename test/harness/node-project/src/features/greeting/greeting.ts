import type { Feature } from "../../shared/feature";

export function greet(name: string): string {
  return `Hello, ${name.trim() || "world"}!`;
}

export const greeting: Feature = {
  title: "Greeting",
  mount(root) {
    const input = document.createElement("input");
    input.className = "w-full rounded border px-2 py-1";
    input.placeholder = "Your name";
    const output = document.createElement("p");
    output.className = "mt-2";
    const render = () => (output.textContent = greet(input.value));
    input.addEventListener("input", render);
    render();
    root.append(input, output);
  },
};
