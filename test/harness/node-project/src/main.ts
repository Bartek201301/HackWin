import "./style.css";
import { counter } from "./features/counter/counter";
import { greeting } from "./features/greeting/greeting";
import { todos } from "./features/todos/todos";
import { renderCard } from "./shared/feature";

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing #app element");

for (const feature of [counter, todos, greeting]) {
  app.append(renderCard(feature));
}
