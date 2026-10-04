#!/usr/bin/env node
// Keeps secrets and private details out of this public repository. Checks what is about to be
// published — file contents and paths, text inside images, commit messages, author and committer
// identities, pull request text — against generic rules plus optional extra rules (one regular
// expression per line) from BOUNDARY_RULES or BOUNDARY_RULES_FILE. A finding names the rule and the
// place, never the matched text; a place that itself matches a rule is replaced by a number.
//
//   boundary.mjs --staged                 staged files, author and committer
//   boundary.mjs --commit-msg <file>      a commit message
//   boundary.mjs --range <base> <head>    every commit in base..head; the whole history of head
//                                         when base is missing, all zeros or unknown
//   boundary.mjs <files…> | -             files, or stdin (e.g. a pull request description)
//
// Images are read with tesseract when it is installed; BOUNDARY_OCR=required makes a missing or
// failing tesseract an error instead of a skipped image.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const generic = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    'provider-key',
    /\b(sk-(proj|ant|live)-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,})\b/,
  ],
  ['machine-email', /@[A-Za-z0-9-]+\.(local|home|lan)\b/],
  [
    'private-network',
    /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
  ],
  ['auth-callback', /[?&](code|access_token|refresh_token|id_token)=[A-Za-z0-9._~-]{12,}/],
];
const rules = [...generic];
const extra =
  process.env.BOUNDARY_RULES ??
  (process.env.BOUNDARY_RULES_FILE ? readFileSync(process.env.BOUNDARY_RULES_FILE, 'utf8') : '');
let broken = false;
extra.split('\n').forEach((line, index) => {
  const rule = line.trim();
  if (!rule || rule.startsWith('#')) return;
  try {
    rules.push([`private-${index + 1}`, new RegExp(rule, 'i')]);
  } catch {
    // The pattern itself is private: report only where it is.
    console.log(`private-${index + 1}: invalid rule`);
    broken = true;
  }
});
if (broken) process.exit(2);

const publicAddress = /^[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$|^noreply@github\.com$/;
const images = /\.(png|jpe?g|gif|webp|bmp|tiff?)$/i;
const ocr = process.env.BOUNDARY_OCR === 'required';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 30 }).replace(/\n$/, '');
const object = (spec) => execFileSync('git', ['cat-file', 'blob', spec], { maxBuffer: 1 << 30 });

let findings = 0;
let places = 0;
const hit = (text) => rules.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
// A place that matches a rule would print what it matched; number it instead.
const label = (place) => (hit(place).length ? `item #${++places}` : place);
const report = (place, rule) => {
  findings++;
  console.log(`${place}: ${rule}`);
};
// GitHub's merge subjects name the source branch as owner/branch; only the branch is ours to check.
const unmerge = (line) => line.replace(/^(Merge pull request #\d+ from )[A-Za-z0-9_.-]+\//, '$1');
const scanText = (place, text) => {
  const where = label(place);
  text.split('\n').forEach((line, index) => {
    for (const rule of hit(unmerge(line))) report(`${where}:${index + 1}`, rule);
  });
};
// Printable runs in common byte encodings, so a NUL byte or UTF-16 cannot hide text from the rules.
const runs = (text) => text.match(/[\x20-\x7e]{4,}/g) ?? [];
const strings = (bytes) => {
  const swapped = bytes.length % 2 ? '' : Buffer.from(bytes).swap16().toString('utf16le');
  return [
    ...runs(bytes.toString('latin1')),
    ...runs(bytes.toString('utf16le')),
    ...runs(swapped),
  ].join('\n');
};
const read = (place, bytes) => {
  if (images.test(place)) {
    try {
      // Tesseract sees only the image: no environment, so no private rules.
      return execFileSync('tesseract', ['stdin', 'stdout'], {
        input: bytes,
        env: { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 1 << 26,
      }).toString('utf8');
    } catch {
      if (ocr) report(label(place), 'image-not-read');
    }
  }
  const text = bytes.toString('utf8');
  return text.includes('\0') || text.includes('�') ? strings(bytes) : text;
};
const scanFile = (place, bytes) => {
  for (const rule of hit(place)) report(`path of ${label(place)}`, rule);
  scanText(place, read(place, bytes));
};
const identity = (place, name, email) => {
  for (const rule of hit(`${name} <${email}>`)) report(place, rule);
  if (!publicAddress.test(email)) report(place, 'address-not-public');
};

const scanCommit = (sha) => {
  const short = sha.slice(0, 12);
  const [an, ae, cn, ce] = git('show', '-s', '--format=%an%x00%ae%x00%cn%x00%ce', sha).split('\0');
  identity(`commit ${short} author`, an, ae);
  identity(`commit ${short} committer`, cn, ce);
  scanText(`commit ${short} message`, git('show', '-s', '--format=%B', sha));
  // Every path the commit adds or changes, against each parent, including the root commit.
  const changed = git(
    'diff-tree',
    '--root',
    '-r',
    '-m',
    '--no-commit-id',
    '--no-renames',
    '--name-only',
    '-z',
    '--diff-filter=ACMRT',
    sha,
  );
  for (const path of new Set(changed.split('\0').filter(Boolean))) {
    const spec = `${sha}:${path}`;
    if (git('cat-file', '-t', spec) === 'blob') scanFile(`${short}:${path}`, object(spec));
  }
};
const exists = (sha) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const [mode, value, second] = process.argv.slice(2);
if (mode === '--staged') {
  for (const path of git('diff', '--cached', '--name-only', '--diff-filter=ACMRT', '-z').split(
    '\0',
  ))
    if (path) scanFile(path, object(`:${path}`));
  for (const [variable, place] of [
    ['GIT_AUTHOR_IDENT', 'author'],
    ['GIT_COMMITTER_IDENT', 'committer'],
  ]) {
    const [, name = '', email = ''] = git('var', variable).match(/^(.*) <(.*)>/) ?? [];
    identity(place, name, email);
  }
} else if (mode === '--commit-msg') {
  scanText('commit message', readFileSync(value, 'utf8'));
} else if (mode === '--range') {
  const range = exists(value) ? [`${value}..${second}`] : [second];
  for (const sha of git('rev-list', '--reverse', ...range)
    .split('\n')
    .filter(Boolean))
    scanCommit(sha);
} else {
  for (const path of mode ? process.argv.slice(2) : ['-'])
    if (path === '-') scanText('stdin', readFileSync(0, 'utf8'));
    else scanFile(path, readFileSync(path));
}

if (findings) {
  console.log(
    `${findings} problem${findings === 1 ? '' : 's'}: this repository is public. Remove secrets and private details, then try again.`,
  );
  process.exit(1);
}
