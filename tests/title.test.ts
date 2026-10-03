import { expect, test } from 'vitest';
import { chatTitle } from '../src/core/title';

test('a chat title is the first line in plain words, short', () => {
  expect(chatTitle('Plan a trip to Lisbon')).toBe('Plan a trip to Lisbon');
  expect(chatTitle('/tool mcp__show {}')).toBe('mcp show');
  expect(chatTitle('\n**Draft** my `weekly` report\nmore')).toBe('Draft my weekly report');
  expect(chatTitle('Summarise https://example.com/a/very/long/link please')).toBe(
    'Summarise please',
  );
  expect(chatTitle('{}', 'photo.png')).toBe('photo.png');
  expect(chatTitle('Write a long and detailed plan for my small bakery opening in spring')).toBe(
    'Write a long and detailed plan for my…',
  );
});
