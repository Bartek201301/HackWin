// The contract between the app shell and every feature area.
export interface Feature {
  title: string;
  mount(root: HTMLElement): void;
}

// Renders a feature inside a card. Owned by the shared role.
export function renderCard(feature: Feature): HTMLElement {
  const card = document.createElement("section");
  card.className = "rounded-lg bg-white p-4 shadow";
  const heading = document.createElement("h2");
  heading.className = "mb-3 font-semibold";
  heading.textContent = feature.title;
  const body = document.createElement("div");
  card.append(heading, body);
  feature.mount(body);
  return card;
}
