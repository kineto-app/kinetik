# Temporary service-worker plugin probe

Source: `index.html`, `app.js`, `sw.js`, `server.py`, `plugin-offline.js` (renamed from `plugin.js` to prove cached execution), `esm.js`, `late.js`. Results from the completed run are in `results.json`.

To reproduce from this directory, first copy `plugin-offline.js` to `plugin.js`. Run `python3 server.py`. In another terminal:

```sh
playwright-cli -s=kinetik-sw-probe open http://127.0.0.1:18763
playwright-cli -s=kinetik-sw-probe eval 'async () => ({ install: await send({op:"install"}), esm: await send({op:"esm"}), late: await send({op:"late"}) })'
playwright-cli -s=kinetik-sw-probe run-code 'async page => { const cdp = await page.context().newCDPSession(page); await cdp.send("ServiceWorker.enable"); await cdp.send("ServiceWorker.stopAllWorkers"); await cdp.detach(); return await page.evaluate(() => send({op:"run"})); }'
```

Rename/remove `plugin.js`, repeat the last command, and observe a new boot ID with result 42. Close only this browser session with `playwright-cli -s=kinetik-sw-probe close`; Ctrl-C the server. This probe deliberately allows `unsafe-eval` in worker CSP. A favicon 404 is unrelated to test results.

This is an isolated feasibility fixture, not application code. The test server permits string compilation for its entire temporary origin; production would need a deliberately scoped worker response policy. It does not prove continuous background execution, natural browser eviction, Safari/Firefox support, or authenticated networking. No server or browser process is left running.
