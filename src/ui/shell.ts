import { icon } from './icons';
import { filesDialog } from './files';
import { automationDialog } from './automations';

export const shell = `
<div id="ui-announcement" class="sr-only" role="status"></div>
<a class="skip-link" href="#prompt">Skip to message</a>
<div class="layout">
  <aside class="sidebar" id="sidebar" aria-label="Chats">
    <div class="brand"><img src="./icon.svg" width="32" height="32" alt="" /><span>Kinetik</span><span class="badge">OSS</span><button id="menu-close" class="icon-button" aria-label="Close chats">${icon('close')}</button></div>
    <button class="new-chat" id="new-chat">${icon('plus')}<span>New chat</span></button>
    <div class="history"><h2 class="eyebrow">Recent chats</h2><nav id="conversations" aria-label="Chat list"></nav></div>
    <div class="sidebar-footer">
      <div class="nav-tools"><button id="files-open">${icon('folder')}<span>Files</span></button><button id="automations-open">${icon('clock')}<span>Routines</span></button><button id="settings-open">${icon('settings')}<span>Settings</span></button></div>
      <div class="storage-note"><span class="status-dot"></span><span>Saved on this device</span></div>
    </div>
  </aside>
  <button id="drawer-scrim" class="drawer-scrim" aria-label="Close chats" tabindex="-1" hidden></button>
  <main class="main" id="main">
    <header class="topbar"><button id="menu" class="icon-button" aria-label="Toggle chats" aria-expanded="false" aria-controls="sidebar">${icon('menu')}</button><div class="heading"><h1 id="title">New chat</h1></div><button id="connection-status" hidden aria-label="Manage connections"></button><span class="status" id="status" role="status">Getting ready</span></header>
    <div id="app-update" class="app-update" role="status" hidden><div><strong>Update available</strong><span id="app-update-feedback" class="field-hint">Apply when you’re ready. Your workspace will be kept.</span></div><button id="app-update-apply" class="primary">Update</button></div>
    <div class="conversation-stage"><section id="timeline" aria-label="Conversation" aria-live="polite" aria-relevant="additions text"></section><button id="jump-latest" class="jump-latest" type="button" hidden>Latest message ${icon('download')}</button></div>
    <section class="composer-area">
      <div id="background-activity" class="activity background-activity" role="status" hidden><span class="spinner" aria-hidden="true"></span><span id="background-label"></span></div>
      <div id="activity" class="activity" role="status" hidden><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><span id="activity-label">Working</span></div>
      <div id="recovery" class="panel" hidden><p>A step was interrupted. Check what changed before trying it again.</p><div class="actions"><button class="secondary" id="resolve">Continue without repeating</button><button id="retry">Try that step again</button></div></div>
      <div id="error" class="feedback" role="alert"></div>
      <form id="composer" class="composer"><label class="sr-only" for="prompt">Message</label><textarea id="prompt" aria-describedby="composer-hint" placeholder="Message Kinetik…" rows="2" maxlength="16384"></textarea><div class="composer-actions"><div class="composer-tools"><button type="button" id="attach" class="icon-button" aria-label="Add or open files" title="Files">${icon('plus')}</button><span class="model-label">${icon('spark')}<span id="model-label">Preview</span></span></div><div class="actions"><button type="button" id="stop" class="secondary" hidden><span class="stop-mark"></span>Stop</button><button class="primary" id="send" type="submit" disabled aria-label="Send" title="Send"><span class="sr-only">Send</span>${icon('send')}</button></div></div></form>
      <div class="composer-foot"><span id="composer-hint">Enter to send · Shift + Enter for a new line</span><span id="model-status">Preview · ChatGPT is not connected</span></div>
    </section>
  </main>
</div>
<dialog id="plugins-dialog" aria-labelledby="plugins-heading" aria-describedby="plugins-description">
  <div class="dialog-head"><span class="glyph">${icon('plug')}</span><div><h2 id="plugins-heading">Connections</h2></div><button data-close="plugins-dialog" class="icon-button" aria-label="Close connections">${icon('close')}</button></div>
  <p id="plugins-description" class="muted">Only add trusted connections. They can access your files and chats.</p>
  <section class="panel"><h3 class="section-label">Installed</h3><div id="plugin-list" class="section-body"></div></section>
  <section class="panel"><h3 class="section-label">Advanced setup</h3><details class="advanced"><summary>Add a custom connection</summary><form id="plugin-form" class="section-body"><label for="plugin-source">Connection link</label><input id="plugin-source" type="url" required placeholder="https://example.org/plugin.json" aria-describedby="source-hint" /><p id="source-hint" class="field-hint">Use the link from your service.</p><details class="advanced"><summary>Connection options <span class="muted">Optional</span></summary><label for="plugin-settings">Advanced settings (JSON)</label><textarea id="plugin-settings" spellcheck="false" aria-describedby="settings-hint">{}</textarea><p id="settings-hint" class="field-hint">Use the configuration supplied with the connection link.</p></details><div class="form-actions"><button type="button" id="example" class="secondary">Use demo connection</button><button class="primary" id="install" type="submit">Add connection</button></div></form></details></section>
  <p id="plugin-error" class="feedback" role="status" aria-live="polite"></p>
</dialog>
${filesDialog}
<dialog id="settings-dialog" aria-labelledby="settings-heading">
  <div class="dialog-head"><span class="glyph">${icon('settings')}</span><div><h2 id="settings-heading">Settings</h2></div><button data-close="settings-dialog" class="icon-button" aria-label="Close settings">${icon('close')}</button></div>
  <section class="panel"><h3 class="section-label">Your assistant</h3><div class="section-body settings-section"><strong id="model-settings-title">You're trying a preview</strong><p id="model-settings-description" class="field-hint">The examples save real files on this device. Open-ended AI chat and ChatGPT sign-in aren't connected yet.</p></div></section>
  <section class="panel" id="managed-section" hidden><h3 class="section-label">Your connections</h3><div class="section-body managed-connections"><div><div class="grow"><strong>Charms</strong><small id="charms-state" class="muted"></small></div><button id="connection-open" class="secondary">Manage</button><button id="connection-disconnect" class="secondary" hidden>Disconnect</button></div><div><div class="grow"><strong>ChatGPT</strong><small id="chatgpt-state" class="muted"></small></div><button id="chatgpt-open" class="secondary">Manage</button><button id="chatgpt-disconnect" class="secondary" hidden>Disconnect</button></div></div></section><section class="panel"><h3 class="section-label">Appearance</h3><div class="section-body settings-section"><label for="appearance">Theme</label><select id="appearance" aria-label="Appearance"><option value="system">Use device setting</option><option value="light">Light</option><option value="dark">Dark</option></select></div></section>
  <section class="panel"><h3 class="section-label">Connected services</h3><div class="section-body"><button id="plugins-open" class="action-row">${icon('plug')}<span class="action-main"><span class="action-title">Manage connections</span></span><span id="plugin-count" class="nav-count">0</span>${icon('chevron')}</button></div></section>
</dialog>${automationDialog}`;
