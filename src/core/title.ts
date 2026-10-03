/** A short chat title from the first message: its first line, without commands or markup. */
export function chatTitle(text: string, fallback = 'New chat'): string {
  const line =
    text
      .split('\n')
      .find((value) => value.trim())
      ?.replace(/^\s*\/\w+\s*/, '')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/[`*#_>{}[\]<>|~=]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() ?? '';
  if (!/\p{L}/u.test(line)) return fallback;
  if (line.length <= 40) return line;
  const cut = line.slice(0, 40);
  return (
    cut.slice(0, cut.lastIndexOf(' ') > 20 ? cut.lastIndexOf(' ') : 40).replace(/[,.;:-]+$/, '') +
    '…'
  );
}
