/** Character offsets always refer to the block's full text, regardless of inline typography. */
export function textNodes(element: Node): Text[] {
  if (element instanceof Text) return [element];
  const children = element.childNodes ? [...element.childNodes] : element.firstChild ? [element.firstChild] : [];
  return children.flatMap(textNodes);
}

export function blockText(element: Node): string {
  return element.textContent ?? textNodes(element).map((node) => node.data).join("");
}

export function textPosition(element: Node, offset: number): { node: Text; offset: number } | null {
  if (!Number.isInteger(offset) || offset < 0) return null;
  for (const node of textNodes(element)) {
    if (offset <= node.data.length) return { node, offset };
    offset -= node.data.length;
  }
  return null;
}

export function offsetInBlock(element: Node | null, node: Node, offset: number): number {
  if (!element) return 0;
  let before = 0;
  for (const text of textNodes(element)) {
    if (text === node) return before + offset;
    before += text.data.length;
  }
  // Browser selections can anchor on an element boundary instead of a text node.
  const range = document.createRange();
  try {
    range.selectNodeContents(element);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch { return 0; }
}

export function rangeWithin(element: Node, start: number, end: number): Range | null {
  if (end < start) return null;
  const from = textPosition(element, start);
  const to = textPosition(element, end);
  if (!from || !to) return null;
  const range = document.createRange();
  range.setStart(from.node, from.offset);
  range.setEnd(to.node, to.offset);
  return range;
}
