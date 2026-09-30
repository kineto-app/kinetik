import { createServer } from 'vite';
import { context } from 'esbuild';
import { readFile } from 'node:fs/promises';
const worker = await context({
  entryPoints: ['src/sw.ts'],
  outfile: '.dev/sw.js',
  bundle: true,
  platform: 'browser',
  alias: { 'node:zlib': new URL('../src/browser/no-zlib.ts', import.meta.url).pathname },
  target: 'es2022',
  format: 'iife',
  define: { __PRECACHE__: '[]', __BUILD_ID__: '"dev"' },
});
await worker.watch();
const server = await createServer({
  plugins: [
    {
      name: 'worker',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url?.split('?')[0] !== '/sw.js') return next();
          try {
            res.setHeader('Content-Type', 'text/javascript');
            res.setHeader('Cache-Control', 'no-store');
            res.end(await readFile('.dev/sw.js'));
          } catch (error) {
            next(error);
          }
        });
      },
    },
  ],
});
await server.listen();
server.printUrls();
const stop = async () => {
  await server.close();
  await worker.dispose();
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
