import { expect, test, vi } from 'vitest';
import { Store } from '../src/browser/store';
import { Plugins } from '../src/plugins/loader';
import { plainNotice } from '../src/ui/notice';
import type { InstalledPlugin, Plugin, SkillSnapshot } from '../src/core/types';

const installed: InstalledPlugin = {
  manifest: { id: 'remote', name: 'Remote', version: '1', apiVersion: 1, entry: 'plugin.js' },
  source: 'https://plugins.example/remote/plugin.json',
  resolvedSource: 'https://plugins.example/remote/plugin.json',
  code: '',
  digest: 'digest',
  settings: {},
  enabledAt: 1,
};
const snapshot = (revision: string): SkillSnapshot => ({
  revision,
  skills: [{ name: 'guide', description: 'Guide', path: 'guide/SKILL.md', content: revision }],
});
/** A skill source whose refreshes the test settles by hand. */
function source() {
  const calls: {
    resolve: (value: SkillSnapshot) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
  }[] = [];
  const plugin: Plugin = {
    skills: {
      sync: (_previous, signal) =>
        new Promise((resolve, reject) => calls.push({ resolve, reject, signal })),
    },
  };
  return { calls, sources: [{ installed, plugin }] };
}
const until = async (check: () => boolean) => {
  while (!check()) await new Promise((resolve) => setTimeout(resolve, 1));
};
async function primed() {
  const plugins = new Plugins(new Store(crypto.randomUUID()));
  plugins.skillsWaitMs = 20;
  const first = source();
  const turn = plugins.sync(first.sources, new AbortController().signal);
  await until(() => first.calls.length === 1);
  first.calls[0].resolve(snapshot('saved'));
  await turn;
  return plugins;
}

test('a slow or cancelled refresh leaves the turn on its saved skills without a notice', async () => {
  const plugins = await primed();
  const slow = source();
  const result = await plugins.sync(slow.sources, new AbortController().signal);
  expect(result.warnings).toEqual([]);
  expect(result.skills.map((skill) => skill.content)).toEqual(['saved']);
  // The refresh is not tied to the turn that started it, and finishes for the next one.
  expect(slow.calls[0].signal.aborted).toBe(false);
  slow.calls[0].resolve(snapshot('newer'));

  plugins.skillsWaitMs = 10_000;
  const failing = source();
  const pending = plugins.sync(failing.sources, new AbortController().signal);
  await until(() => failing.calls.length === 1);
  failing.calls[0].reject(new Error('Request canceled'));
  const next = await pending;
  expect(next.warnings).toEqual([]);
  expect(next.skills.map((skill) => skill.content)).toEqual(['newer']);
});

test('turns that start together share one refresh', async () => {
  const plugins = await primed();
  plugins.skillsWaitMs = 10_000;
  const shared = source();
  const turns = [1, 2, 3].map(() => plugins.sync(shared.sources, new AbortController().signal));
  await until(() => shared.calls.length === 1);
  shared.calls[0].resolve(snapshot('shared'));
  for (const turn of await Promise.all(turns))
    expect(turn.skills.map((skill) => skill.content)).toEqual(['shared']);
  expect(shared.calls).toHaveLength(1);
});

test('stopping a turn stops only its wait, not the refresh other turns share', async () => {
  const plugins = await primed();
  plugins.skillsWaitMs = 10_000;
  const shared = source();
  const stopped = new AbortController();
  const first = plugins.sync(shared.sources, stopped.signal);
  const second = plugins.sync(shared.sources, new AbortController().signal);
  await until(() => shared.calls.length === 1);
  stopped.abort(new Error('Stopped.'));
  await expect(first).rejects.toThrow('Stopped.');
  shared.calls[0].resolve(snapshot('after stop'));
  expect((await second).skills.map((skill) => skill.content)).toEqual(['after stop']);
});

test('only a turn without any saved skills hears about a failed refresh, in a quiet note', async () => {
  const plugins = new Plugins(new Store(crypto.randomUUID()));
  const failing = source();
  const pending = plugins.sync(failing.sources, new AbortController().signal);
  await until(() => failing.calls.length === 1);
  failing.calls[0].reject(new Error('Request canceled'));
  const { warnings, skills } = await pending;
  expect(skills).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(plainNotice(warnings[0])).toEqual({ title: warnings[0], failed: false });
});

test('connecting waits for the refresh and reports its failure even with saved skills', async () => {
  const plugins = await primed();
  const failing = source();
  const pending = plugins.sync(failing.sources, new AbortController().signal, true);
  await until(() => failing.calls.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 40));
  failing.calls[0].reject(new Error('unavailable'));
  const { warnings, skills } = await pending;
  expect(warnings).toEqual(['Remote: skill sync failed. unavailable']);
  expect(skills.map((skill) => skill.content)).toEqual(['saved']);
  vi.restoreAllMocks();
});
