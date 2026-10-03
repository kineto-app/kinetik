import { icon, type IconName } from './icons';
import { filesDialog } from './files';
import { automationDialog } from './automations';
import { SettingsDialog } from './settings';

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
          <div class="history">
            <nav id="conversations" aria-label="Recent chats"></nav>
          </div>
          <div class="sidebar-footer">
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
              <button id="install-open" hidden>
                <Icon name="download" />
                <span>Install Kinetik</span>
              </button>
            </div>
            <div class="storage-note">
              <span class="status-dot"></span>
              <span>Saved on this device</span>
            </div>
            <button class="new-chat" id="new-chat">
              <Icon name="compose" />
              <span>New chat</span>
            </button>
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
            <button
              id="delete-chat"
              class="icon-button"
              aria-label="Delete chat"
              title="Delete chat"
              hidden
            >
              <Icon name="trash" />
            </button>
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
            <div id="toasts" class="toasts" role="status" aria-live="polite"></div>
            <section
              id="timeline"
              aria-label="Conversation"
              aria-live="polite"
              aria-relevant="additions text"
            ></section>
            <button
              id="jump-latest"
              class="jump-latest"
              type="button"
              aria-label="Latest message"
              title="Latest message"
              hidden
            >
              <Icon name="arrowDown" />
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
              {/* The reply block in the chat shows the work; this line is for screen readers. */}
              <div id="activity" class="sr-only" role="status" hidden>
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
            <section id="ask" class="ask-card" aria-live="polite" hidden></section>
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
            <div id="attachment-status" class="field-hint" role="status"></div>
            <form id="composer" class="composer">
              <div
                id="attachments"
                class="attachment-tray"
                role="list"
                aria-label="Attached files"
                hidden
              ></div>
              <div class="composer-row">
                <button
                  type="button"
                  id="attach"
                  class="icon-button"
                  aria-label="Add files"
                  title="Add files"
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
                <div id="model-picker"></div>
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
                    type="button"
                    id="queue"
                    class="icon-button"
                    hidden
                    aria-label="Send after current work"
                    title="Send after current work"
                  >
                    <Icon name="clock" />
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
              </div>
            </form>
            <div class="composer-foot sr-only">
              <span id="composer-hint">Enter for a new line. Use Send to send your message.</span>
              <span id="model-status">Preview · ChatGPT is not connected</span>
            </div>
          </section>
        </main>
      </div>
      <StaticMarkup html={filesDialog} />
      <SettingsDialog />
      <StaticMarkup html={automationDialog} />
    </>
  );
}
