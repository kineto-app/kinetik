import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { parseConfiguration } from '../../src/connections/config';

test('native apps ship with Charms, configured by public endpoints only', () => {
  const raw = readFileSync('native.config.json', 'utf8');
  const config = parseConfiguration(JSON.parse(raw), new URL('https://tauri.localhost/'));
  expect(config.connections.charms?.url).toBe('https://kineto.app/api/charms/mcp');
  expect(raw).not.toMatch(/secret|token|password|private|key/i);
});
