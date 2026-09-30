import { icon } from './icons';

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60
    ? `${minutes}m ${seconds % 60}s`
    : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
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
