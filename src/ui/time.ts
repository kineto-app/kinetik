import { icon } from './icons';

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "now", "5m", "3h", a weekday within a week, then a short date. */
export function shortAge(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return minutes + 'm';
  if (minutes < 24 * 60) return Math.floor(minutes / 60) + 'h';
  const date = new Date(timestamp);
  if (minutes < 7 * 24 * 60) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function messageTime(timestamp: number): HTMLTimeElement {
  const time = document.createElement('time');
  time.className = 'message-time';
  const date = new Date(timestamp);
  time.dateTime = date.toISOString();
  time.textContent = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  time.title = date.toLocaleString();
  time.setAttribute('aria-label', `Sent ${date.toLocaleString()}`);
  return time;
}

export function workDuration(ms: number): HTMLElement {
  const summary = document.createElement('div');
  summary.className = 'work-duration';
  summary.title = 'Elapsed time, including connection waits';
  summary.innerHTML = icon('clock');
  summary.append(document.createTextNode('Worked for ' + elapsed(ms)));
  return summary;
}
