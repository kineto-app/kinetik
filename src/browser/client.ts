import { isNative } from '../platform/environment';
let ready: Promise<ServiceWorkerRegistration>;
export async function connect(): Promise<ServiceWorkerRegistration | undefined> {
  if (isNative) {
    await (await import('../platform/native')).connectNative();
    return;
  }
  if (!('serviceWorker' in navigator) || !('locks' in navigator))
    throw new Error('This browser needs Service Workers and Web Locks in a secure context.');
  return (ready ??= navigator.serviceWorker
    .register(new URL('sw.js', document.baseURI), { scope: './', updateViaCache: 'none' })
    .then(() => navigator.serviceWorker.ready));
}
export async function rpc<T = void>(op: string, data: Record<string, unknown> = {}): Promise<T> {
  if (isNative) return (await import('../platform/native')).nativeRPC<T>(op, data);
  const registration = await connect();
  return workerRPC<T>(registration!.active!, op, data);
}
export function workerRPC<T = void>(
  worker: ServiceWorker,
  op: string,
  data: Record<string, unknown> = {},
): Promise<T> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      reject(new Error('Worker did not respond. Reopen the app to recover.'));
    }, 60000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      channel.port1.close();
      if (event.data.ok) resolve(event.data.result as T);
      else reject(new Error(event.data.error));
    };
    worker.postMessage({ op, ...data }, [channel.port2]);
  });
}
