import type { AppView } from '../core/types';
import { rpc } from '../browser/client';

// MCP Apps standard style names, mapped to the same tokens as the chat.
function hostStyles() {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const tokens: Record<string, string> = {
    '--color-background-primary': '--ground',
    '--color-background-secondary': '--card',
    '--color-background-tertiary': '--panel',
    '--color-background-info': '--glyph-bg',
    '--color-background-success': '--ok-soft',
    '--color-background-danger': '--bad-soft',
    '--color-text-primary': '--ink',
    '--color-text-secondary': '--muted',
    '--color-text-info': '--accent-ink',
    '--color-text-success': '--ok',
    '--color-text-danger': '--bad',
    '--color-border-primary': '--control-line',
    '--color-border-secondary': '--line',
    '--color-ring-primary': '--accent',
    '--font-sans': '--font-sans',
    '--border-radius-sm': '--radius-control',
    '--border-radius-md': '--radius-inner',
    '--border-radius-lg': '--radius',
    '--border-radius-xl': '--radius-island',
    '--border-radius-full': '--radius-pill',
    '--shadow-sm': '--chat-shadow',
  };
  return {
    theme: root.dataset.theme === 'dark' ? 'dark' : 'light',
    styles: {
      variables: Object.fromEntries(
        Object.entries(tokens).map(([name, token]) => [name, css.getPropertyValue(token).trim()]),
      ),
    },
  };
}

// An opaque sandbox proxy keeps MCP views outside the PWA origin.
function domains(values?: string[]): string {
  return (Array.isArray(values) ? values : [])
    .filter(
      (value) =>
        typeof value === 'string' &&
        /^(https:|wss:)\/\/(\*\.)?[a-zA-Z0-9.-]+(?::\d+)?$/.test(value),
    )
    .join(' ');
}
export function appHTML(view: AppView): string {
  const csp = view.csp ?? {};
  const resources = domains(csp.resourceDomains);
  const policy = `default-src 'none'; script-src 'unsafe-inline' ${resources}; style-src 'unsafe-inline' ${resources}; img-src data: ${resources}; font-src ${resources || "'none'"}; media-src data: ${resources}; connect-src ${domains(csp.connectDomains) || "'none'"}; frame-src ${domains(csp.frameDomains) || "'none'"}; base-uri ${domains(csp.baseUriDomains) || "'none'"}; object-src 'none'; form-action 'none'`;
  return (
    `<meta http-equiv="Content-Security-Policy" content="${policy.replaceAll('"', '&quot;')}">` +
    view.html
  );
}
export function mountApp(
  container: HTMLElement,
  view: AppView,
  conversationId: string,
): () => void {
  const frame = document.createElement('iframe');
  frame.title = 'MCP App';
  frame.className = 'mcp-app';
  frame.sandbox.add('allow-scripts', 'allow-same-origin');
  frame.src = new URL('app-sandbox.html', document.baseURI).href;
  const send = (data: unknown) => frame.contentWindow?.postMessage(data, '*');
  const notify = (method: string, params: unknown) => send({ jsonrpc: '2.0', method, params });
  let ready = false;
  let busy = false;
  const listener = async (event: MessageEvent) => {
    if (event.source !== frame.contentWindow || event.origin !== 'null') return;
    const data = event.data;
    if (!data || data.jsonrpc !== '2.0' || typeof data.method !== 'string') return;
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: data.id, result });
    try {
      if (data.method === 'ui/notifications/sandbox-proxy-ready') {
        notify('ui/notifications/sandbox-resource-ready', { html: appHTML(view) });
        return;
      }
      if (data.method === 'ui/initialize') {
        reply({
          protocolVersion: '2026-01-26',
          hostInfo: { name: 'kinetik-oss', version: '0.1.0' },
          hostCapabilities: { serverTools: {}, message: {} },
          hostContext: {
            ...hostStyles(),
            displayMode: 'inline',
            availableDisplayModes: ['inline'],
            locale: navigator.language,
            containerDimensions: { width: container.clientWidth },
          },
        });
        return;
      }
      if (data.method === 'ui/notifications/initialized') {
        ready = true;
        // Catch a theme change between initialize and initialized.
        notify('ui/notifications/host-context-changed', hostStyles());
        notify('ui/notifications/tool-input', { arguments: view.input });
        notify('ui/notifications/tool-result', view.result);
        return;
      }
      if (!ready) throw new Error('App has not initialized.');
      if (data.method === 'ui/notifications/size-changed') {
        frame.style.height =
          Math.min(900, Math.max(120, Number(data.params?.height) || 300)) + 'px';
        return;
      }
      if (data.method === 'ping') {
        reply({});
        return;
      }
      if (data.method === 'ui/request-display-mode') {
        reply({ mode: 'inline' });
        return;
      }
      if (data.method === 'tools/call') {
        if (busy) throw new Error('Wait for the active app request.');
        busy = true;
        try {
          reply(
            await rpc('appCall', {
              id: view.id,
              name: data.params?.name,
              input: data.params?.arguments ?? {},
            }),
          );
        } finally {
          busy = false;
        }
        return;
      }
      if (data.method === 'ui/message') {
        const content = data.params?.content;
        if (!Array.isArray(content)) throw new Error('Expected message content.');
        const text = content
          .filter((item: { type: string }) => item.type === 'text')
          .map((item: { text: string }) => item.text)
          .join('\n');
        await rpc('submit', { id: conversationId, text });
        reply({});
        return;
      }
      if (data.id !== undefined)
        send({
          jsonrpc: '2.0',
          id: data.id,
          error: { code: -32601, message: 'Method is not supported by this host.' },
        });
    } catch (error) {
      if (data.id !== undefined)
        send({
          jsonrpc: '2.0',
          id: data.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'App request failed.',
          },
        });
    }
  };
  window.addEventListener('message', listener);
  const themeObserver = new MutationObserver(() => {
    if (ready) notify('ui/notifications/host-context-changed', hostStyles());
  });
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  const loading = new AbortController();
  // The response CSP applies the opaque-origin sandbox after navigation, allowing
  // the navigation itself to be served by our worker while fully offline.
  void fetch(frame.src, { signal: loading.signal })
    .then((response) => {
      const policy = response.headers.get('Content-Security-Policy') ?? '';
      if (
        !response.ok ||
        !policy.split(';').some((directive) => directive.trim() === 'sandbox allow-scripts')
      )
        throw new Error('App sandbox security header is missing.');
      if (!loading.signal.aborted) container.append(frame);
    })
    .catch((error) => {
      if (!loading.signal.aborted) {
        const note = document.createElement('p');
        note.className = 'feedback';
        note.textContent = String(error);
        container.append(note);
      }
    });
  return () => {
    loading.abort();
    themeObserver.disconnect();
    window.removeEventListener('message', listener);
    frame.remove();
  };
}
