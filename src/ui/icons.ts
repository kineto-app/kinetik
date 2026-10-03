// Kinetik Charms icons. See THIRD_PARTY_NOTICES.md.
const paths = {
  expand: ['M8 3H3v5', 'M16 3h5v5', 'M3 16v5h5', 'M21 16v5h-5'],
  openArrow: ['M7 17 17 7', 'M7 7h10v10'],
  refresh: [
    'M21 12a9 9 0 0 0-15.74-6.26L3 8',
    'M3 3v5h5',
    'M3 12a9 9 0 0 0 15.74 6.26L21 16',
    'M16 16h5v5',
  ],
  info: ['M12 11v6', 'M12 7h.01', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
  external: ['M14 3h7v7', 'M21 3 10 14', 'M10 3H3v18h18v-7'],
  stop: ['M6 6h12v12H6z'],
  file: ['M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z', 'M14 2v4a2 2 0 0 0 2 2h4'],
  folder: ['M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'],
  spark: ['M12 3.5 13.9 9l5.6 2-5.6 2-1.9 5.5L10.1 13 4.5 11l5.6-2z'],
  plug: ['M9 2v6', 'M15 2v6', 'M6 8h12v3a6 6 0 0 1-12 0z', 'M12 17v5'],
  message: ['M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2z', 'M7 9h10', 'M7 13h7'],
  chevron: ['m9 18 6-6-6-6'],
  back: ['m15 18-6-6 6-6'],
  user: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'],
  moon: ['M20 14A8 8 0 1 1 10 4a6 6 0 0 0 10 10z'],
  box: ['M3 7l9-4 9 4v10l-9 4-9-4z', 'M3 7l9 4 9-4', 'M12 11v10'],
  data: [
    'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z',
    'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6',
    'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  ],
  close: ['M18 6 6 18', 'm6 6 12 12'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  upload: ['M12 15V3', 'm7 8 5-5 5 5', 'M4 19h16'],
  download: ['M12 3v12', 'm7 10 5 5 5-5', 'M4 19h16'],
  copy: ['M9 9h10v11H9z', 'M15 9V5H5v10h4'],
  check: ['m4.5 12.8 5 5 10-11'],
  send: [
    'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z',
    'm21.854 2.147-10.94 10.939',
  ],
  plus: ['M12 5v14', 'M5 12h14'],
  compose: [
    'M12 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-7',
    'm16 3 5 5',
    'm9 15 1-5 9-9 4 4-9 9z',
  ],
  arrowUp: ['M12 19V5', 'm6 11 6-6 6 6'],
  arrowDown: ['M12 5v14', 'm6 13 6 6 6-6'],
  more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  terminal: ['m4 6 6 6-6 6', 'M12 18h8'],
  settings: ['M4 7h16', 'M4 17h16', 'M8 4v6', 'M16 14v6'],
  clock: ['M12 8v4l3 2', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0'],
  monitor: ['M3 4h18v13H3z', 'M8 21h8', 'M12 17v4'],
  bolt: ['M13 2 4 14h7l-1 8 9-12h-7z'],
  bell: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.9 1.9 0 0 0 3.4 0'],
  book: ['M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z', 'M4 21V5'],
  brain: [
    'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 0V7a3 3 0 0 0-3-3z',
    'M15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 0',
  ],
} as const;
export type IconName = keyof typeof paths;
export function icon(name: IconName): string {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name].map((d) => `<path d="${d}" />`).join('')}</svg>`;
}
