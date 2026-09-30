import { icon, type IconName } from './icons';
import { filesDialog } from './files';
import { automationDialog } from './automations';

function Icon(props: { name: IconName }) {
  return <span class="icon-slot" innerHTML={icon(props.name)} />;
}
function StaticMarkup(props: { html: string }) {
  return <div class="dialog-slot" innerHTML={props.html} />;
}
/** Shared application shell. Behavior is migrated component by component. */
export function Shell() {
  return (
    <>
      <div id="ui-announcement" class="sr-only" role="status"></div>
      <a class="skip-link" href="#prompt">
        Skip to message
      </a>
      <div class="layout">
        <aside class="sidebar" id="sidebar" aria-label="Chats">
          <div class="brand">
            <img src="./icon.svg" width="32" height="32" alt="" />
            <span>Kinetik</span>
            <button id="menu-close" class="icon-button" aria-label="Close chats">
              <Icon name="close" />
            </button>
          </div>
          <button class="new-chat" id="new-chat">
            <Icon name="compose" />
            <span>New chat</span>
          </button>
          <div class="history">
            <h2 class="eyebrow">Recent chats</h2>
            <nav id="conversations" aria-label="Chat list"></nav>
          </div>
          <div class="sidebar-footer">
            <button id="install-open" class="secondary" hidden>
              <Icon name="download" />
              <span>Install Kinetik</span>
            </button>
            <div class="nav-tools">
              <button id="connections-open">
                <Icon name="plug" />
                <span class="connection-nav-text">
                  <span>Connections</span>
                  <small id="connections-summary">Manage services</small>
                </span>
                <span id="connections-dot" class="status-dot" aria-hidden="true" hidden></span>
              </button>
              <button id="automations-open">
                <Icon name="clock" />
                <span>Routines</span>
              </button>
              <button id="settings-open">
                <Icon name="settings" />
                <span>Settings</span>
              </button>
            </div>
            <div class="storage-note">
              <span class="status-dot"></span>
              <span>Saved on this device</span>
            </div>
          </div>
        </aside>
        <button
          id="drawer-scrim"
          class="drawer-scrim"
          aria-label="Close chats"
          tabindex="-1"
          hidden
        ></button>
        <main class="main" id="main">
          <header class="topbar">
            <button
              id="menu"
              class="icon-button"
              aria-label="Toggle chats"
              aria-expanded="false"
              aria-controls="sidebar"
            >
              <Icon name="menu" />
            </button>
            <div class="heading">
              <img src="./icon.svg" width="26" height="26" alt="" />
              <h1 id="title">New chat</h1>
            </div>
            <button id="connection-status" hidden aria-label="Connection needs attention"></button>
            <span class="status sr-only" id="status" role="status">
              Getting ready
            </span>
            <button id="top-new-chat" class="icon-button" aria-label="New chat" title="New chat">
              <Icon name="compose" />
            </button>
          </header>
          <div id="app-update" class="app-update" role="status" hidden>
            <div>
              <strong>Update available</strong>
              <span id="app-update-feedback" class="field-hint"></span>
            </div>
            <button id="app-update-apply" class="primary">
              Update
            </button>
          </div>
          <div class="conversation-stage">
            <section
              id="timeline"
              aria-label="Conversation"
              aria-live="polite"
              aria-relevant="additions text"
            ></section>
            <button id="jump-latest" class="jump-latest" type="button" hidden>
              Latest message <Icon name="download" />
            </button>
          </div>
          <section class="composer-area">
            <div class="work-status">
              <div
                id="background-activity"
                class="activity background-activity"
                role="status"
                hidden
              >
                <span class="spinner" aria-hidden="true"></span>
                <span id="background-label"></span>
              </div>
              <div id="activity" class="activity" role="status" hidden>
                <span class="thinking-dots" aria-hidden="true">
                  <i></i>
                  <i></i>
                  <i></i>
                </span>
                <span id="activity-label">Working</span>
              </div>
              <div id="connection-wait" class="activity" role="status" hidden>
                <span id="connection-wait-label"></span>
                <button id="resume-work" class="secondary">
                  Retry
                </button>
              </div>
              <details id="work-options" class="work-options" hidden>
                <summary aria-label="Work options">
                  <Icon name="more" />
                </summary>
                <div>
                  <button id="cancel-work">
                    <Icon name="stop" />
                    Stop work
                  </button>
                </div>
              </details>
            </div>
            <div id="recovery" class="panel" hidden>
              <p>A step was interrupted. Check what changed before trying it again.</p>
              <div class="actions">
                <button class="secondary" id="resolve">
                  Continue without repeating
                </button>
                <button id="retry">Try that step again</button>
              </div>
            </div>
            <div id="error" class="feedback" role="alert"></div>
            <form id="composer" class="composer">
              <button
                type="button"
                id="attach"
                class="icon-button"
                aria-label="Add a file"
                title="Add a file"
              >
                <Icon name="plus" />
              </button>
              <label class="sr-only" for="prompt">
                Message
              </label>
              <textarea
                id="prompt"
                aria-describedby="composer-hint"
                placeholder="Message Kinetik…"
                rows="1"
                maxlength="16384"
              ></textarea>
              <div class="composer-actions">
                <button
                  type="button"
                  id="stop"
                  class="primary"
                  hidden
                  aria-label="Stop"
                  title="Stop"
                >
                  <Icon name="stop" />
                </button>
                <button
                  class="primary"
                  id="send"
                  type="submit"
                  disabled
                  aria-label="Send"
                  title="Send"
                >
                  <Icon name="arrowUp" />
                </button>
              </div>
              <span class="sr-only" id="model-label">
                Preview
              </span>
            </form>
            <div class="composer-foot sr-only">
              <span id="composer-hint">Enter to send · Shift + Enter for a new line</span>
              <span id="model-status">Preview · ChatGPT is not connected</span>
            </div>
          </section>
        </main>
      </div>
      <dialog
        id="plugins-dialog"
        aria-labelledby="plugins-heading"
        aria-describedby="plugins-description"
      >
        <div class="dialog-head">
          <span class="glyph">
            <Icon name="plug" />
          </span>
          <div>
            <h2 id="plugins-heading">Connections</h2>
          </div>
          <button data-close="plugins-dialog" class="icon-button" aria-label="Close connections">
            <Icon name="close" />
          </button>
        </div>
        <p id="plugins-description" class="muted">
          Only add trusted connections. They can access your files and chats.
        </p>
        <section class="panel">
          <h3 class="section-label">Installed</h3>
          <div id="plugin-list" class="section-body"></div>
        </section>
        <section class="panel">
          <h3 class="section-label">Advanced setup</h3>
          <details class="advanced">
            <summary>Add a custom connection</summary>
            <form id="plugin-form" class="section-body">
              <label for="plugin-source">Connection link</label>
              <input
                id="plugin-source"
                type="url"
                required
                placeholder="https://example.org/plugin.json"
                aria-describedby="source-hint"
              />
              <p id="source-hint" class="field-hint">
                Use the link from your service.
              </p>
              <details class="advanced">
                <summary>
                  Connection options <span class="muted">Optional</span>
                </summary>
                <label for="plugin-settings">Advanced settings (JSON)</label>
                <textarea id="plugin-settings" spellcheck="false" aria-describedby="settings-hint">
                  {'{}'}
                </textarea>
                <p id="settings-hint" class="field-hint">
                  Use the configuration supplied with the connection link.
                </p>
              </details>
              <div class="form-actions">
                <button type="button" id="example" class="secondary">
                  Use demo connection
                </button>
                <button class="primary" id="install" type="submit">
                  Add connection
                </button>
              </div>
            </form>
          </details>
        </section>
        <p id="plugin-error" class="feedback" role="status" aria-live="polite"></p>
      </dialog>
      <StaticMarkup html={filesDialog} />
      <dialog id="settings-dialog" aria-labelledby="settings-heading">
        <div class="dialog-head">
          <span class="glyph">
            <Icon name="settings" />
          </span>
          <div>
            <h2 id="settings-heading">Settings</h2>
          </div>
          <button data-close="settings-dialog" class="icon-button" aria-label="Close settings">
            <Icon name="close" />
          </button>
        </div>
        <section class="panel">
          <h3 class="section-label">Your assistant</h3>
          <div class="section-body settings-section">
            <strong id="model-settings-title">You're trying a preview</strong>
            <p id="model-settings-description" class="field-hint">
              The examples save real files on this device. Open-ended AI chat and ChatGPT sign-in
              aren't connected yet.
            </p>
          </div>
        </section>
        <section class="panel" id="managed-section" hidden>
          <h3 class="section-label">Your connections</h3>
          <div class="section-body managed-connections">
            <div>
              <div class="grow">
                <strong>Charms</strong>
                <small id="charms-state" class="muted"></small>
              </div>
              <button id="connection-open" class="secondary">
                Manage
              </button>
              <button id="connection-disconnect" class="secondary" hidden>
                Disconnect
              </button>
            </div>
            <div>
              <div class="grow">
                <strong>ChatGPT</strong>
                <small id="chatgpt-state" class="muted"></small>
              </div>
              <button id="chatgpt-open" class="secondary">
                Manage
              </button>
              <button id="chatgpt-disconnect" class="secondary" hidden>
                Disconnect
              </button>
            </div>
          </div>
        </section>
        <section class="panel">
          <h3 class="section-label">Appearance</h3>
          <div class="section-body settings-section">
            <label for="appearance">Theme</label>
            <select id="appearance" aria-label="Appearance">
              <option value="system">Use device setting</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>
        </section>
        <section class="panel">
          <h3 class="section-label">Your data</h3>
          <div class="section-body settings-section">
            <p class="field-hint">
              Transfer chats, files, and paused routines. Sign-ins and connection settings stay on
              this device.
            </p>
            <div class="actions">
              <button id="archive-export" class="secondary">
                Export data
              </button>
              <button id="archive-import" class="secondary">
                Import data
              </button>
            </div>
            <input id="archive-file" type="file" accept="application/json,.json" hidden />
            <p id="archive-status" class="field-hint" role="status"></p>
          </div>
        </section>
        <section class="panel">
          <h3 class="section-label">Connected services</h3>
          <div class="section-body">
            <button id="plugins-open" class="action-row">
              <Icon name="plug" />
              <span class="action-main">
                <span class="action-title">Manage connections</span>
              </span>
              <span id="plugin-count" class="nav-count">
                0
              </span>
              <Icon name="chevron" />
            </button>
          </div>
        </section>
      </dialog>
      <StaticMarkup html={automationDialog} />
    </>
  );
}
