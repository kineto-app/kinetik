# Kinetik OSS

A small browser agent prototype with a persistent workspace, just-bash, native skills, and JavaScript plugins that can replace its tools. The chat interface uses Kinetik Charms styles.

**This version uses a deterministic local test model, not an LLM.** No prompts go to OpenAI. Official ChatGPT subscription authentication is not implemented: the selected browser credential design conflicts with the current documented storage requirements. See [feasibility findings](RESEARCH.md).

![Kinetik local workspace](docs/images/desktop.png)

## Run locally

Requires Node.js 22.12 or newer and a modern browser with Service Workers, Web Locks, and IndexedDB. Chromium desktop and mobile-sized Chromium are automated test targets.

```sh
git clone https://github.com/kineto-app/kinetik.git
cd kinetik
npm ci
npm run build
npm start
```

The launcher opens `http://127.0.0.1:4173/`. Once the PWA confirms its offline assets are cached, **the entire launcher process exits**. Keep the same address to reopen it. Browser site-data deletion removes files, conversations, and plugins; export important files first. Install the PWA through your browser's app-install action if desired.

For development with a running server:

```sh
npm run dev
```

To keep the production static server available, including for plugin development:

```sh
KINETIK_KEEP_ALIVE=1 npm start
```

The npm package is prepared but has not been published. To try the actual distributable without publishing:

```sh
npm pack
npx --package ./kinetik-oss-0.1.0.tgz kinetik-oss
```

No global installation, account, API key, or external service is needed for the local prototype. The bundled example plugin works offline; third-party plugin installation and refresh require network access.

## Try it

The mock model understands explicit commands so runtime behavior is reproducible:

```text
/exec printf "hello from Kinetik\n" > note.txt; cat note.txt
/read /workspace/note.txt
/list /workspace
/skills
/read_skill skills/local/workspace/SKILL.md
/tool edit {"path":"/workspace/note.txt","oldText":"hello","newText":"hi"}
```

`/write /workspace/note.txt` followed by a new line and content replaces a file. Shift+Enter inserts a line in the composer. `/tool plugin__tool {"argument":"value"}` invokes another enabled tool.

Conversations run concurrently and share `/workspace`. New messages steer an active conversation after its current tool finishes. Stop aborts model work and requests tool cancellation; an uncertain effect stays visible for review. On a worker restart, uncertain calls pause rather than execute twice. Resolving without retry continues; retry is an explicit user action.

Files live in a virtual filesystem, not arbitrary host folders. Import/export handles files up to 4 MiB per import. This small-workspace implementation persists each operation, with limits of 16 MiB and 2,000 entries. It delegates shell filesystem semantics to just-bash's InMemoryFs, including its replacement behavior for writes through hard-linked paths. Whole scripts are not transactions.

The shell exposes a selected set of file/text commands, pipes, and shell syntax. Network commands, Python, JavaScript execution, SQLite, gzip, and native processes are excluded. Commands are bounded to 15 seconds; plugin calls receive a 30-second timeout. Trusted JavaScript can ignore cancellation or block its worker, so this is not a hard sandbox guarantee.

## Plugins and skills

Open **Plugins**, select **Use example URL**, install, then enable it. Its `exec` replacement echoes what it received instead of running a shell. Disable it to restore local execution. Its skill appears in `/skills` and loads through `read_skill` independently of workspace replacements.

Plugins are trusted JavaScript. They can access the app's origin storage and network. Installation downloads code; enabling permits execution. Updates are explicit, and active turns retain their code/tool bindings. Skill sources are checked for every message and cached on failure. The last explicitly enabled plugin wins a replacement; updating code does not change priority.

Supported install sources are direct HTTPS manifest/folder/entry URLs and public GitHub repository/folder/file links. HTTP is accepted only for loopback development. GitHub refs resolve to a commit, then installed source bytes and their digest are stored locally. Private repository authentication and runtime npm/TypeScript compilation are not implemented.

See [the plugin contract](docs/plugins.md) and [the bundled example](public/plugins/example/plugin.js). A minimal [HTTP MCP plugin](public/plugins/mcp/plugin.js) is also included. It uses a supplied endpoint and optional bearer token; OAuth login, automatic MCP reconnection, Apps/iframes, and push subscriptions are not included. No live Charms connection has been validated. Localhost-to-Charms still needs server CORS support.

## Configuration

Set environment variables in the shell; `.env` files are not automatically loaded. See [.env.example](.env.example).

| Variable               | Default     | Purpose                                           |
| ---------------------- | ----------- | ------------------------------------------------- |
| `KINETIK_BIND`         | `127.0.0.1` | Static server listen address.                     |
| `KINETIK_PORT`         | `4173`      | Stable local origin port.                         |
| `KINETIK_OPEN_BROWSER` | `1`         | Set to `0` to print the URL without opening it.   |
| `KINETIK_KEEP_ALIVE`   | `0`         | Set to `1` for a persistent static server.        |
| `KINETIK_BASE_PATH`    | `/`         | Serve under a path such as `/kinetik-oss/`.       |
| `KINETIK_PUBLIC_URL`   | Local URL   | Browser-facing URL behind an HTTPS reverse proxy. |

Static `dist/` files can be self-hosted. Serve `sw.js` as JavaScript with CSP permitting trusted factory compilation (`script-src 'self' 'unsafe-eval'`) and network destinations needed by plugins. The UI itself does not require `unsafe-eval`. See [deployment notes](docs/deployment.md). A remote machine requires HTTPS, not plain LAN HTTP, for service workers. This is a static delivery option, not a remote agent runner.

Hosting at `kineto.app/kinetik-oss` shares the main site's origin. Worker scope does not isolate plugin privileges. The owner accepted this choice for now; no hosted deployment has been made.

## Development and checks

```sh
npm ci
npx playwright install chromium
npm run check
```

`check` runs formatting validation, strict TypeScript checking, unit/integration tests, a production build, and browser tests. CI installs Chromium's system dependencies too. The browser suite exercises persistence/offline reload, URL plugins, skills, updates, parallel turns, steering, Stop, and recovery after forced service-worker termination. It does not prove continuous background execution on mobile or real model authentication.

Browser suspension is normal. Work resumes when the browser activates the app; there is no guaranteed closed-app scheduler. Goals, routines, MCP Apps, VM runners, a full Charms plugin, and real model login remain outside this prototype.

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Design](DESIGN.md) · [Research](RESEARCH.md)

## License

[MIT, copyright Kineto](LICENSE). Dependencies and reused visual assets are listed in [third-party notices](THIRD_PARTY_NOTICES.md). The license does not grant trademark rights.
