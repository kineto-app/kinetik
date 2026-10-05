import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseConfiguration } from '../../src/connections/config';

const parse = (path: string) =>
  parseConfiguration(JSON.parse(readFileSync(path, 'utf8')), new URL('https://tauri.localhost/'));

test('native builds ship without preset connections unless a distributor adds them', () => {
  expect(parse('native.config.json').connections).toEqual({});
});

test('the example preset is a valid Charms connection with public endpoints only', () => {
  const raw = readFileSync('native.config.example.json', 'utf8');
  expect(parse('native.config.example.json').connections.charms?.url).toBe(
    'https://charms.example.com/mcp',
  );
  expect(raw).not.toMatch(/secret|token|password|private|key/i);
});
