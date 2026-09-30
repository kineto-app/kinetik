/** The response sandbox keeps an iframe opaque after its same-origin navigation. */
export const sandboxCSP =
  "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: https:; font-src https:; media-src data: https:; connect-src https: wss:; frame-src about: https:; base-uri https:; object-src 'none'; form-action 'none'; sandbox allow-scripts";
