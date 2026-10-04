# AGENTS.md

Guidance for AI coding agents working in this repository. How to build, test and structure changes is
in [CONTRIBUTING.md](CONTRIBUTING.md); this file adds the rule agents most often break.

## This repository is public

Everything you write here is published the moment it is pushed and cannot be fully taken back:
code, code comments, commit messages and trailers, branch names, pull request titles and descriptions,
review and issue comments, docs, README, test fixtures, screenshots, videos and CI output.

Write only about this app. Never include:

- details of any company's or person's private systems: other repositories, internal paths and
  services, build or deploy pipelines, cloud accounts, hosts, job or secret names, incidents;
- how a hosted service behaves inside — describe only what this app does;
- people's names, emails, chat or wiki links, or who decided what; internal review or planning;
- credentials or anything that looks like one, even fake — tests generate them at run time;
- screenshots or recordings that show tokens, filled sign-in callbacks or private URLs.

Commit with your public GitHub noreply address. The boundary check runs before every commit
(`npm ci` installs the hooks) and on every pull request. Check a pull request description or
comment before posting it — write it to a file, then:

```sh
npm run boundary -- description.md
```

If the check fails, rewrite the text in plain app terms; do not disguise the word.
