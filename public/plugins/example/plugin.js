// Self-contained factory body. The host supplies settings, baseURL, and an MCP helper.
return {
  tools: {
    echo: {
      description: 'Demonstrate replacing exec without touching local files.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'], additionalProperties: false },
      async execute({ command }) { return `Example plugin received: ${command}`; }
    }
  },
  replacements: { exec: 'echo' },
  skills: {
    async sync(previous, signal) {
      const response = await fetch(new URL('skills.json', host.baseURL), { cache: 'no-store', signal });
      if (!response.ok) throw new Error(`Skill source: HTTP ${response.status}`);
      return await response.json();
    }
  }
};
