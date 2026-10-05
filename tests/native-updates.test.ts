import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  rpc: vi.fn(),
  toast: vi.fn(),
  replace: vi.fn(),
  parseArchive: vi.fn(),
  banner: { hidden: true, querySelector: vi.fn() },
  action: { hidden: false },
  feedback: { textContent: '' },
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }));
vi.mock('../src/browser/client', () => ({ rpc: mocks.rpc }));
vi.mock('../src/ui/toast', () => ({ toast: mocks.toast }));
vi.mock('../src/ui/update-banner', () => ({ updateBanner: () => mocks }));
vi.mock('../src/platform/secure-store', () => ({
  NativeStore: class {
    replace = mocks.replace;
  },
}));
vi.mock('../src/core/archive', () => ({ parseArchive: mocks.parseArchive }));
import {
  setupNativeUpdates,
  restoreUpdateSnapshot,
  reportUpdateFirstUse,
  type UpdateStatus,
} from '../src/platform/updates';

let status: UpdateStatus;
let events: Record<string, () => void>;
let frames: FrameRequestCallback[];
let doc: { hidden: boolean; addEventListener: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  status = {
    enabled: true,
    healthConfigured: true,
    reportsEnabled: true,
    staged: null,
    snapshotNeeded: false,
    restart: false,
  };
  events = {};
  frames = [];
  const listen = vi.fn((name: string, callback: () => void) => {
    events[name] = callback;
  });
  doc = { hidden: false, addEventListener: listen };
  vi.stubGlobal('window', { addEventListener: listen });
  vi.stubGlobal('document', doc);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
  mocks.banner.hidden = true;
  mocks.action.hidden = false;
  mocks.banner.querySelector.mockReturnValue({ textContent: '' });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'updates_status' || command === 'updates_check') return { ...status };
    if (command === 'updates_ready') return true;
    if (command === 'updates_restore') return null;
    if (command === 'updates_snapshot') status.snapshotNeeded = false;
  });
  mocks.rpc.mockResolvedValue('{}');
  mocks.replace.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function paint() {
  await Promise.resolve();
  frames.shift()!(0);
  frames.shift()!(0);
}
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

test('acknowledges only after paint, silently stages and shows a restart hint', async () => {
  status.staged = '1.1.0';
  status.restart = true;
  const setup = setupNativeUpdates();
  await Promise.resolve();
  expect(mocks.invoke).not.toHaveBeenCalledWith('updates_ready');
  await paint();
  await setup;
  await settle();
  expect(mocks.invoke).toHaveBeenCalledWith('updates_ready');
  expect(mocks.invoke).toHaveBeenCalledWith('updates_check');
  expect(mocks.toast).toHaveBeenCalledWith({ text: 'Kinetik was updated', ms: 4000 });
  expect(mocks.banner.hidden).toBe(false);
  expect(mocks.action.hidden).toBe(true);
});
test('disabled builds do not schedule network checks or acknowledge a boot', async () => {
  status.enabled = false;
  await setupNativeUpdates();
  expect(mocks.invoke.mock.calls).toEqual([['updates_status']]);
  expect(frames).toHaveLength(0);
});
test('foreground, online and visible interval check; hidden interval does not', async () => {
  const setup = setupNativeUpdates();
  await paint();
  await setup;
  await settle();
  mocks.invoke.mockClear();
  doc.hidden = true;
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
  expect(mocks.invoke).not.toHaveBeenCalledWith('updates_check');
  doc.hidden = false;
  events.visibilitychange();
  await settle();
  expect(mocks.invoke).toHaveBeenCalledWith('updates_check');
  mocks.invoke.mockClear();
  events.online();
  await settle();
  expect(mocks.invoke).toHaveBeenCalledWith('updates_check');
  mocks.invoke.mockClear();
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
  expect(mocks.invoke).toHaveBeenCalledWith('updates_check');
});
test('busy workspace leaves a format upgrade waiting and retries when online', async () => {
  status.staged = '1.1.0';
  status.snapshotNeeded = true;
  mocks.rpc.mockRejectedValueOnce(new Error('Work is running'));
  const setup = setupNativeUpdates();
  await paint();
  await setup;
  await settle();
  expect(mocks.invoke).not.toHaveBeenCalledWith('updates_snapshot', expect.anything());
  events.online();
  await settle();
  expect(mocks.invoke).toHaveBeenCalledWith('updates_snapshot', { version: '1.1.0', text: '{}' });
});
test('failed feeds preserve the staged restart hint and do not reject startup', async () => {
  status.restart = true;
  const base = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command: string) =>
    command === 'updates_check' ? Promise.reject(new Error('offline')) : base(command),
  );
  const setup = setupNativeUpdates();
  await paint();
  await setup;
  await settle();
  expect(mocks.banner.hidden).toBe(false);
});
test('restores snapshots before acknowledgement and retains connection configuration', async () => {
  mocks.invoke.mockResolvedValueOnce('snapshot');
  mocks.parseArchive.mockResolvedValue([['filesystem', {}]]);
  await restoreUpdateSnapshot();
  expect(mocks.replace).toHaveBeenCalledWith([['filesystem', {}]], expect.any(Function));
  const retain = mocks.replace.mock.calls[0][1];
  expect(retain('connection-token:a')).toBe(true);
  expect(retain('deployment-config')).toBe(true);
  expect(retain('conversation:a')).toBe(false);
  expect(mocks.invoke).toHaveBeenLastCalledWith('updates_restore', { complete: true });
});
test('failed restore keeps the native snapshot for the next boot', async () => {
  mocks.invoke.mockResolvedValueOnce('snapshot');
  mocks.parseArchive.mockRejectedValueOnce(new Error('invalid'));
  await expect(restoreUpdateSnapshot()).rejects.toThrow('invalid');
  expect(mocks.invoke).not.toHaveBeenCalledWith('updates_restore', { complete: true });
});
test('first-use IPC sends only its outcome and absorbs reporting failures', async () => {
  mocks.invoke.mockRejectedValueOnce(new Error('disk full'));
  reportUpdateFirstUse(false);
  await settle();
  expect(mocks.invoke).toHaveBeenCalledWith('updates_first_use', { ok: false });
});
