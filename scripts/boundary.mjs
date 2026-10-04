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

const publicAddress =
  /^([0-9]+\+)?[A-Za-z0-9-]+(\[bot\])?@users\.noreply\.github\.com$|^noreply@github\.com$/;
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
const scanText = (place, text, check = hit) => {
  const where = label(place);
  text.split('\n').forEach((line, index) => {
    for (const rule of check(line)) report(`${where}:${index + 1}`, rule);
  });
};
// GitHub's merge subjects name the source branch as this repository's owner/branch; in exactly that
// line, only the branch is ours to check.
const owner = (() => {
  if (process.env.GITHUB_REPOSITORY_OWNER) return process.env.GITHUB_REPOSITORY_OWNER;
  try {
    return execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).match(/github\.com[:/]([^/]+)\//)?.[1];
  } catch {
    return undefined;
  }
})();
const scanMessage = (place, text) =>
  scanText(place, text, (line) => {
    const merge = owner && /^Merge pull request #\d+ from /.test(line);
    return hit(merge ? line.replace(`from ${owner}/`, 'from ') : line);
  });
// Printable runs in common byte encodings, so a NUL byte or UTF-16 cannot hide text from the rules.
const runs = (text) => text.match(/[\x20-\x7e]+/g) ?? [];
const pairs = (bytes) => bytes.subarray(0, bytes.length - (bytes.length % 2));
const strings = (bytes) =>
  [
    ...runs(bytes.toString('latin1')),
    ...runs(pairs(bytes).toString('utf16le')),
    ...runs(Buffer.from(pairs(bytes)).swap16().toString('utf16le')),
    ...runs(pairs(bytes.subarray(1)).toString('utf16le')),
  ].join('\n');
const decode = (bytes) => {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return pairs(bytes.subarray(2)).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return Buffer.from(pairs(bytes.subarray(2)))
      .swap16()
      .toString('utf16le');
  const text = bytes.toString('utf8');
  return text.includes('\0') || text.includes('\ufffd') ? strings(bytes) : text;
};
// The bytes always, and for images also the text tesseract reads in them.
const read = (place, bytes) => {
  const text = decode(bytes);
  if (images.test(place)) {
    try {
      // Tesseract sees only the image: no environment, so no private rules.
      return `${text}\n${execFileSync('tesseract', ['stdin', 'stdout'], {
        input: bytes,
        env: { PATH: process.env.PATH },
        stdio: ['pipe', 'pipe', 'ignore'],
        maxBuffer: 1 << 26,
      }).toString('utf8')}`;
    } catch {
      if (ocr) report(label(place), 'image-not-read');
    }
  }
  return text;
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
  scanMessage(`commit ${short} message`, git('show', '-s', '--format=%B', sha));
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
  scanMessage('commit message', readFileSync(value, 'utf8'));
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
