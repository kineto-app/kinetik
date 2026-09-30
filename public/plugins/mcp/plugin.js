// Settings: { "url": "https://server.example/mcp", "token": "optional bearer" }
return (async () => {
  if (!host.settings.url) throw new Error('Set the MCP url in plugin settings.');
  const client = host.mcp(host.settings.url, host.settings.token);
  return { tools: await client.tools() };
})();
