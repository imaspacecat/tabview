export const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
export function create<K extends keyof HTMLElementTagNameMap>(tag: K, properties: Partial<HTMLElementTagNameMap[K]> & { data?: Record<string, string | undefined> } = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const { data, ...props } = properties;
  const node = Object.assign(document.createElement(tag), props);
  Object.assign(node.dataset, data);
  node.append(...children);
  return node;
}
