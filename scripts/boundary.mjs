#!/usr/bin/env node
// Keeps secrets and private details out of this public repository. Checks staged files, commit
// messages and authors, a commit range, or text from files/stdin. Extra rules (one regular
// expression per line) come from BOUNDARY_RULES_FILE or BOUNDARY_RULES; a hit names the rule and
// the place, never the matched text, so the output is safe to publish.
//
//   boundary.mjs --staged                 files about to be committed, and the author
//   boundary.mjs --commit-msg <file>      a commit message
//   boundary.mjs --range <base>..<head>   changed files, messages and authors in a range
//   boundary.mjs <files…> | -             files, or stdin (e.g. a PR description)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const rules = [
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
const extra =
  process.env.BOUNDARY_RULES ??
  (process.env.BOUNDARY_RULES_FILE ? readFileSync(process.env.BOUNDARY_RULES_FILE, 'utf8') : '');
extra.split('\n').forEach((line, index) => {
  const rule = line.trim();
  if (rule && !rule.startsWith('#')) rules.push([`private-${index + 1}`, new RegExp(rule, 'i')]);
});
// Commits must carry a public address, never a personal or machine one.
const publicAuthor = /@users\.noreply\.github\.com$|^noreply@github\.com$/;

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const blob = (spec) => execFileSync('git', ['show', spec], { maxBuffer: 1 << 28 });
const binary = (bytes) => bytes.subarray(0, 8000).includes(0);

let hits = 0;
const report = (place, rule) => {
  hits++;
  console.log(`${place}: ${rule}`);
};
const scan = (place, text) =>
  text.split('\n').forEach((line, index) => {
    for (const [rule, pattern] of rules)
      if (pattern.test(line)) report(`${place}:${index + 1}`, rule);
  });
const scanPath = (place, bytes) => {
  scan(`${place} (path)`, place);
  if (!binary(bytes)) scan(place, bytes.toString('utf8'));
};
const author = (place, email) => {
  if (!publicAuthor.test(email)) report(place, 'author-not-public');
};

const [mode, value] = process.argv.slice(2);
if (mode === '--staged') {
  for (const path of git('diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z').split('\0'))
    if (path) scanPath(path, blob(`:${path}`));
  author('author', git('var', 'GIT_AUTHOR_IDENT').replace(/^.*<(.*)>.*$/s, '$1'));
} else if (mode === '--commit-msg') {
  scan('commit message', readFileSync(value, 'utf8'));
} else if (mode === '--range') {
  const head = value.split('..')[1];
  for (const path of git('diff', '--name-only', '--diff-filter=ACMR', '-z', value).split('\0'))
    if (path) scanPath(path, blob(`${head}:${path}`));
  for (const record of git('log', '--format=%H%x00%ae%x00%ce%x00%B%x01', value).split('\x01')) {
    const [sha, authorEmail, committerEmail, message] = record.replace(/^\n/, '').split('\0');
    if (!sha) continue;
    author(`commit ${sha.slice(0, 12)} author`, authorEmail);
    author(`commit ${sha.slice(0, 12)} committer`, committerEmail);
    scan(`commit ${sha.slice(0, 12)} message`, message);
  }
} else {
  for (const path of mode ? process.argv.slice(2) : ['-'])
    if (path === '-') scan('stdin', readFileSync(0, 'utf8'));
    else scanPath(path, readFileSync(path));
}

if (hits) {
  console.log(
    `${hits} problem${hits === 1 ? '' : 's'}: this repository is public. Remove secrets and private details, then try again.`,
  );
  process.exit(1);
}
