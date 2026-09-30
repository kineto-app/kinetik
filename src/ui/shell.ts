import { icon } from './icons';

export const shell = `
<a class="skip-link" href="#prompt">Skip to message</a>
<div class="layout">
  <aside class="sidebar" id="sidebar" aria-label="Conversations">
    <div class="brand"><img src="./icon.svg" width="32" height="32" alt="" /><span>Kinetik</span><span class="badge">OSS</span><button id="menu-close" class="icon-button" aria-label="Close conversations">${icon('close')}</button></div>
    <button class="new-chat" id="new-chat">${icon('plus')}<span>New conversation</span></button>
    <div class="history"><h2 class="eyebrow">Conversations</h2><nav id="conversations" aria-label="Conversation list"></nav></div>
    <div class="sidebar-footer">
      <div class="nav-tools"><button id="plugins-open">${icon('plug')}<span>Plugins</span><span class="nav-count" id="plugin-count">0</span></button><button id="files-open">${icon('folder')}<span>Local files</span></button></div>
      <div class="appearance"><label for="appearance">${icon('monitor')}<span>Appearance</span></label><select id="appearance" aria-label="Appearance"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
      <div class="storage-note"><span class="status-dot"></span><span>Stored in this browser</span></div>
    </div>
  </aside>
  <button id="drawer-scrim" class="drawer-scrim" aria-label="Close conversations" tabindex="-1" hidden></button>
  <main class="main" id="main">
    <header class="topbar"><button id="menu" class="icon-button" aria-label="Toggle conversations" aria-expanded="false" aria-controls="sidebar">${icon('menu')}</button><div class="heading"><h1 id="title">New conversation</h1><span class="small muted">Your local workspace</span></div><span class="status" id="status" role="status">Starting worker</span></header>
    <section id="timeline" aria-label="Conversation" aria-live="polite" aria-relevant="additions text"></section>
    <section class="composer-area">
      <div id="activity" class="activity" role="status" hidden><span class="spinner"></span><span id="activity-label">Working</span></div>
      <div id="recovery" class="panel" hidden><p>A tool's outcome is unknown. Check its effects before continuing.</p><div class="actions"><button class="secondary" id="resolve">Continue without retry</button><button id="retry">Retry the tool</button></div></div>
      <div id="error" class="feedback" role="alert"></div>
      <form id="composer" class="composer"><label class="sr-only" for="prompt">Message</label><textarea id="prompt" aria-describedby="composer-hint" placeholder="Try /exec echo hello" rows="2" maxlength="16384"></textarea><div class="composer-actions"><div class="composer-tools"><button type="button" id="attach" class="icon-button" aria-label="Import or export files" title="Local files">${icon('plus')}</button><span class="model-label">${icon('terminal')}Local test model</span></div><div class="actions"><button type="button" id="stop" class="secondary" hidden><span class="stop-mark"></span>Stop</button><button class="primary" id="send" type="submit" disabled><span>Send</span>${icon('send')}</button></div></div></form>
      <div class="composer-foot"><span id="composer-hint">Enter to send · Shift + Enter for a new line</span><span>Mock model · No OpenAI requests</span></div>
    </section>
  </main>
</div>
<dialog id="plugins-dialog" aria-labelledby="plugins-heading" aria-describedby="plugins-description">
  <div class="dialog-head"><span class="glyph">${icon('plug')}</span><div><h2 id="plugins-heading">Plugins</h2><p class="small muted">Tools and native skills, your way.</p></div><button data-close="plugins-dialog" class="icon-button" aria-label="Close plugins">${icon('close')}</button></div>
  <p id="plugins-description" class="muted">Plugins can add skills and replace workspace tools. Only enable code you trust: it can access this app’s data.</p>
  <section class="panel"><h3 class="section-label">Installed</h3><div id="plugin-list" class="section-body"></div></section>
  <section class="panel"><h3 class="section-label">Add a plugin</h3><form id="plugin-form" class="section-body"><label for="plugin-source">Manifest or repository URL</label><input id="plugin-source" type="url" required placeholder="https://example.org/plugin.json" aria-describedby="source-hint" /><p id="source-hint" class="field-hint">HTTPS URL or a GitHub link to a plugin folder or file.</p><details class="advanced"><summary>Plugin settings <span class="muted">Optional</span></summary><label for="plugin-settings">Settings as JSON</label><textarea id="plugin-settings" spellcheck="false" aria-describedby="settings-hint">{}</textarea><p id="settings-hint" class="field-hint">Use string values for settings such as an MCP endpoint.</p></details><div class="form-actions"><button type="button" id="example" class="secondary">Use example URL</button><button class="primary" id="install" type="submit">Install plugin</button></div></form></section>
  <p id="plugin-error" class="feedback" role="status" aria-live="polite"></p>
  <p class="field-hint">The last enabled replacement wins. Code updates are manual; skills refresh before every message.</p>
</dialog>
<dialog id="files-dialog" aria-labelledby="files-heading" aria-describedby="files-description">
  <div class="dialog-head"><span class="glyph">${icon('folder')}</span><div><h2 id="files-heading">Local files</h2><p class="small muted">Shared by all your conversations.</p></div><button data-close="files-dialog" class="icon-button" aria-label="Close files">${icon('close')}</button></div>
  <p id="files-description" class="muted">Import from your device or download a workspace file. These controls always use the local workspace.</p>
  <section class="panel"><h3 class="section-label">Import a file</h3><div class="section-body upload-zone"><input type="file" id="upload" class="sr-only" aria-describedby="upload-hint" /><label for="upload" class="upload-pick">${icon('upload')}<span>Choose a file</span></label><p id="upload-hint" class="field-hint">Up to 4 MiB · Saved in /workspace</p></div></section>
  <section class="panel"><h3 class="section-label">Download a file</h3><form id="download-form" class="section-body"><label for="download-path">Workspace path</label><div class="download-row"><input id="download-path" value="/workspace/note.txt" required spellcheck="false" /><button class="primary">${icon('download')}<span>Download</span></button></div></form></section>
  <p id="file-result" class="feedback" role="status"></p>
</dialog>`;
