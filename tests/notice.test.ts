import { expect, test } from 'vitest';
import { plainNotice } from '../src/ui/notice';

test('a technical notice reads in plain words and keeps the original as detail', () => {
  expect(plainNotice("ENOENT: no such file or directory, open '/x/trip.md'")).toEqual({
    title: 'I couldn’t find that file.',
    detail: "ENOENT: no such file or directory, open '/x/trip.md'",
    failed: true,
  });
  expect(plainNotice('Model completed without a message or tool call.').title).toBe(
    'The answer didn’t come through.',
  );
  expect(plainNotice('Error: {"code":"bad_request"}')).toMatchObject({
    title: 'Something went wrong.',
    failed: true,
  });
  expect(plainNotice('Rate limit reached for requests').title).toBe(
    'ChatGPT is busy right now. Try again in a minute.',
  );
  expect(plainNotice('Nothing to summarise yet.')).toEqual({
    title: 'Nothing to summarise yet.',
    failed: false,
  });
});
