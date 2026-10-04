// Draws the chat backdrop: dotted contour lines that flow around dotted Kinetik cats.
// Writes public/backdrop-light.svg and public/backdrop-dark.svg. Run: node scripts/backdrop.mjs
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';

const W = 1200;
const H = 1600;
const n = 96;

// The icon split into two masks: the black cat and its coral hat.
const icon = readFileSync('public/icon.svg', 'utf8');
const browser = await chromium.launch();
const page = await browser.newPage();
const { cat: rawCat, hat: rawHat } = await page.evaluate(
  async ({ src, n }) => {
    const img = new Image();
    img.src = 'data:image/svg+xml;utf8,' + encodeURIComponent(src);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = n;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0, n, n);
    const d = context.getImageData(0, 0, n, n).data;
    const near = (i, r, g, b) => Math.hypot(d[i] - r, d[i + 1] - g, d[i + 2] - b) / 441;
    const cat = [];
    const hat = [];
    for (let i = 0; i < n * n; i++) {
      const a = d[i * 4 + 3] / 255;
      cat.push(a * Math.max(0, 1 - near(i * 4, 25, 22, 22) * 3));
      hat.push(a * Math.max(0, 1 - near(i * 4, 255, 95, 75) * 3));
    }
    return { cat, hat };
  },
  { src: icon, n },
);
await browser.close();

const blur = (grid, r) => {
  let a = grid;
  for (let pass = 0; pass < 2; pass++) {
    const b = new Array(n * n).fill(0);
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const X = x + dx;
            const Y = y + dy;
            if (X >= 0 && Y >= 0 && X < n && Y < n) {
              sum += a[Y * n + X];
              count++;
            }
          }
        b[y * n + x] = sum / count;
      }
    a = b;
  }
  return a;
};
const halo = blur(
  rawCat.map((v, i) => Math.max(v, rawHat[i])),
  4,
);
const lookup = (grid, u, v) => {
  if (u < 0 || v < 0 || u >= n - 1 || v >= n - 1) return 0;
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fu = u - i;
  const fv = v - j;
  const q = (a, b) => grid[b * n + a];
  return (
    q(i, j) * (1 - fu) * (1 - fv) +
    q(i + 1, j) * fu * (1 - fv) +
    q(i, j + 1) * (1 - fu) * fv +
    q(i + 1, j + 1) * fu * fv
  );
};
// Each cat is [centre x, centre y, width]. Phones show the middle 720 px of the width and desktops
// the middle 750 px of the height, so most cats sit where both can see them.
const cats = [
  [430, 560, 300],
  [820, 920, 230],
  [360, 1180, 260],
  [800, 1400, 190],
  [700, 250, 170],
  [130, 820, 210],
  [1080, 600, 240],
  [560, 1520, 150],
  [1060, 1180, 170],
  [150, 300, 160],
];
const at = (grid) => (x, y) => {
  let m = 0;
  for (const [cx, cy, size] of cats) {
    const k = n / size;
    m = Math.max(m, lookup(grid, (x - cx) * k + n / 2, (y - cy) * k + n / 2));
  }
  return m;
};
const cat = at(rawCat);
const hat = at(rawHat);
const near = at(halo);

const dot = (x, y, r) => (r > 0.3 ? `<circle cx="${x}" cy="${y}" r="${r.toFixed(1)}"/>` : '');
let lines = '';
let bodies = '';
let hats = '';
for (let y = 3; y < H; y += 6)
  for (let x = 3; x < W; x += 6) {
    const v =
      Math.sin(x / 210) +
      Math.cos(y / 170) +
      Math.sin((x + y) / 290) +
      0.5 * Math.cos((x - y) / 130) +
      1.6 * near(x, y);
    const d = Math.abs(((((v * 2.4) % 1) + 1) % 1) - 0.5);
    if (d > 0.45 && Math.max(cat(x, y), hat(x, y)) < 0.3) lines += dot(x, y, 1.1);
  }
for (let y = 4; y < H; y += 7)
  for (let x = 4; x < W; x += 7) {
    const c = cat(x, y);
    const h = hat(x, y);
    const r = 1.9 * Math.max(c, h);
    if (h > c + 0.05) hats += dot(x, y, r);
    else bodies += dot(x, y, r);
  }

// Cats sit a notch quieter than the lines and the hat quieter still; light mode needs more ink.
const modes = {
  light: { mid: '#7765E2', hat: '#FF5F4B', opacity: 0.3, cats: 0.55, hats: 0.4 },
  dark: { mid: '#9A8AF0', hat: '#FF7A68', opacity: 0.26, cats: 0.6, hats: 0.45 },
};
for (const [mode, m] of Object.entries(modes)) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid slice">` +
    `<defs><linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${W}" y2="${H}">` +
    `<stop offset="0" stop-color="#FF8FE4"/><stop offset=".5" stop-color="${m.mid}"/><stop offset="1" stop-color="#FF5F4B"/>` +
    `</linearGradient></defs><g opacity="${m.opacity}"><g fill="url(#g)">${lines}</g>` +
    `<g fill="url(#g)" opacity="${m.cats}">${bodies}</g><g fill="${m.hat}" opacity="${m.hats}">${hats}</g></g></svg>\n`;
  writeFileSync(`public/backdrop-${mode}.svg`, svg);
  console.log(`public/backdrop-${mode}.svg`, svg.length);
}
