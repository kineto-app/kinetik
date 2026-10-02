const token =
  /("(?:\\.|[^"\\])*")(\s*:)?|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|\b(true|false|null)\b/g;
// Highlighting a huge payload would stall the page; past this it stays plain text.
const highlightLimit = 200_000;

export const jsonText = (value: unknown) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));

/** Pretty JSON with coloured keys and values, built from text nodes so data stays inert. */
export function jsonView(value: unknown): HTMLPreElement {
  const pre = document.createElement('pre');
  pre.className = 'json-view';
  const text = jsonText(value);
  if (typeof value === 'string' || text.length > highlightLimit) {
    pre.textContent = text;
    return pre;
  }
  let last = 0;
  for (const match of text.matchAll(token)) {
    pre.append(text.slice(last, match.index));
    const span = document.createElement('span');
    span.className = match[1]
      ? match[2]
        ? 'json-key'
        : 'json-string'
      : match[3]
        ? 'json-number'
        : 'json-literal';
    span.textContent = match[1] ?? match[3] ?? match[4];
    pre.append(span);
    if (match[2]) pre.append(match[2]);
    last = match.index + match[0].length;
  }
  pre.append(text.slice(last));
  return pre;
}
