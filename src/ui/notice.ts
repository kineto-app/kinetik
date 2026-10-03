/** What a notice means in plain words; `detail` keeps the original text when it was technical. */
export function plainNotice(text: string): { title: string; detail?: string; failed: boolean } {
  const rules: [RegExp, string][] = [
    [/ENOENT|no such file/i, 'I couldn’t find that file.'],
    [
      /rate.?limit|too many requests|overloaded|busy/i,
      'ChatGPT is busy right now. Try again in a minute.',
    ],
    [/usage limit|quota|insufficient|billing/i, 'You’ve reached your ChatGPT limit for now.'],
    [
      /context|too long|too many (input )?tokens/i,
      'This chat got too long. Start a new chat to continue.',
    ],
    [/sign in|401|403|unauthori[sz]ed|forbidden/i, 'Kinetik needs you to sign in again.'],
    [/^Model |tool (call|arguments)|stopped early/i, 'The answer didn’t come through.'],
    [/fetch|network|unreachable|ECONN|timed? ?out|interrupted/i, 'The connection dropped.'],
  ];
  const known = rules.find(([pattern]) => pattern.test(text));
  if (known) return { title: known[1], detail: text, failed: true };
  // Plain sentences from Kinetik itself read fine as they are.
  if (/^[A-Z][^{}<>`\n]{0,160}[.!?]$/.test(text.trim()) && !/^(Error|TypeError)\b/.test(text))
    return { title: text.trim(), failed: false };
  return { title: 'Something went wrong.', detail: text, failed: true };
}
