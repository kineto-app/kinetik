// just-bash/browser still statically imports zlib. Compression is outside our tool allowlist.
export const constants = { Z_BEST_COMPRESSION: 9, Z_BEST_SPEED: 1, Z_DEFAULT_COMPRESSION: -1 };
export function gunzipSync(): never {
  throw new Error('Gzip is unavailable in the browser workspace.');
}
export function gzipSync(): never {
  throw new Error('Gzip is unavailable in the browser workspace.');
}
