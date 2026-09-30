import { createServer } from 'node:http';
let revision = 1,
  fail = false;
const manifest = {
  id: 'fixture',
  name: 'Fixture plugin',
  version: '1.0.0',
  apiVersion: 1,
  entry: 'plugin.js',
};
const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.end();
  if (req.url === '/control') {
    let data = '';
    for await (const part of req) data += part;
    const state = JSON.parse(data);
    revision = state.revision ?? revision;
    fail = state.fail ?? fail;
    return res.end('ok');
  }
  if (req.url === '/plugin.json') {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify({ ...manifest, version: `${revision}.0.0` }));
  }
  if (req.url === '/plugin.js') {
    res.setHeader('Content-Type', 'text/plain');
    return res.end(
      `return { tools:{echo:{description:'Fixture execution',inputSchema:{type:'object',properties:{command:{type:'string'}},required:['command'],additionalProperties:false},async execute({command}){return 'code-${revision}: '+command;}}},replacements:{exec:'echo'},skills:{async sync(previous,signal){const r=await fetch(new URL('skills.json',host.baseURL),{signal,cache:'no-store'});if(!r.ok)throw new Error('Skill source offline');return await r.json();}}};`,
    );
  }
  if (req.url === '/skills.json') {
    res.setHeader('Content-Type', 'application/json');
    res.statusCode = fail ? 503 : 200;
    return res.end(
      JSON.stringify({
        revision: String(revision),
        skills: [
          {
            name: 'fixture-skill',
            description: `Description ${revision}`,
            path: 'fixture/SKILL.md',
            content: `# Revision ${revision}`,
          },
        ],
      }),
    );
  }
  res.end('ok');
});
server.listen(4174, '127.0.0.1');
