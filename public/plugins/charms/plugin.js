// Settings: url and optional token. All workspace replacements activate together.
return (async () => {
  if (!host.settings.url) throw new Error('Set the Charms MCP url in plugin settings.');
  const client = host.mcp(host.settings.url, host.settings.token);
  const remote = await client.tools();
  const replacements = { exec: 'charms_exec', read: 'charms_files_read', write: 'charms_files_write', edit: 'charms_files_edit', list: 'charms_files_list' };
  for (const name of [...Object.values(replacements), 'charms_skill_find', 'charms_skill_load']) {
    if (!remote[name]) throw new Error('Charms server is missing ' + name);
  }
  const payload = (result, bodyField) => {
    const texts = result.content?.filter(item => item.type === 'text') ?? [];
    const metadata = result.structuredContent ?? (texts[0] && JSON.parse(texts[0].text));
    if (!metadata) throw new Error('Charms returned no structured payload.');
    // Current servers send JSON metadata followed by the exact Markdown/file text.
    // Older servers include that text inside the structured payload.
    if (bodyField && metadata[bodyField] === undefined && texts[1]) {
      return { ...metadata, [bodyField]: texts[1].text };
    }
    return metadata;
  };
  const call = async (name, args, signal) => payload(await client.call(name, args, signal),
    name === 'charms_skill_load' ? 'skill_md' : name === 'charms_files_read' ? 'content' : undefined);
  const pages = async (name, args, signal) => {
    const result = [];
    const visited = new Set();
    while (name) {
      const key = JSON.stringify([name, args]);
      if (visited.has(key) || visited.size >= 100) throw new Error('Charms continuation loop.');
      visited.add(key);
      const page = await call(name, args, signal);
      result.push(page);
      if (!page.next) {
        if (page.truncated && name !== 'charms_skill_find') throw new Error('Incomplete Charms skill.');
        break;
      }
      if (!['charms_skill_find', 'charms_files_read'].includes(page.next.tool)) throw new Error('Unexpected Charms continuation.');
      name = page.next.tool;
      args = page.next.arguments;
    }
    return result;
  };
  // Skill discovery is native synchronization, never an extra model tool.
  const tools = Object.fromEntries(Object.entries(remote).map(([name, tool]) => [name, { ...tool, timeoutMs: 60000 }]));
  delete tools.charms_skill_find;
  delete tools.charms_skill_load;
  const exec = tools.charms_exec;
  tools.charms_exec = {
    ...exec,
    async execute(input, context) {
      const result = await exec.execute(context.background ? { ...input, background: true } : input, context);
      const data = payload(result);
      if (data.job_id) await context.checkpoint(String(data.job_id));
      return result;
    },
    async recover(id, signal) {
      const result = await client.call('charms_job', { job_id: id }, signal);
      const data = payload(result);
      return { done: data.status !== 'running' && data.status !== 'pending', result };
    },
    async wait(id, signal) {
      while (true) {
        signal.throwIfAborted();
        const result = await client.call('charms_job', { job_id: id }, signal);
        const data = payload(result);
        if (!['running', 'pending'].includes(data.status)) return result;
        // Charms currently exposes status reads, not a completion subscription.
        // This adapter waits without invoking the model.
        await new Promise((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(signal.reason); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    },
    async cancel(id) { await client.call('charms_job_cancel', { job_id: id }); },
  };
  return {
    tools, replacements: { ...replacements, show_file: null },
    files: {
      async upload(file, signal) {
        if (!remote.charms_files_upload) throw new Error('Update Charms to enable file uploads.');
        const slot = await call('charms_files_upload', { path: 'files/attachments/' + file.id + '/' + file.name }, signal);
        const url = new URL(slot.upload_url);
        if (url.origin !== new URL(host.settings.url).origin || url.username || url.password || slot.method !== 'PUT' || typeof slot.path !== 'string') throw new Error('Charms returned an invalid upload destination.');
        if (typeof slot.max_bytes !== 'number' || file.bytes.length > slot.max_bytes) throw new Error('This file is too large for Charms.');
        const response = await fetch(url, { method: 'PUT', body: file.bytes, credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/octet-stream' }, signal });
        if (response.status === 202) {
          const receipt = await response.json();
          if (typeof receipt.job_id !== 'string') throw new Error('Charms returned an invalid upload receipt.');
          const result = payload(await tools.charms_exec.wait(receipt.job_id, signal));
          if (result.status !== 'completed' || result.error) throw new Error('The file did not reach Charms. Try sending again.');
        } else if (response.status !== 204) {
          throw new Error('File upload failed. Try sending again.');
        }
        return { path: slot.path };
      },
    },
    skills: {
      async sync(previous, signal) {
        const catalogPages = await pages('charms_skill_find', {}, signal);
        const entries = catalogPages.flatMap(page => page.charms ?? []);
        const first = catalogPages[0];
        if (!Array.isArray(first.charms) || entries.length !== first.total_count || new Set(entries.map(entry => entry.name)).size !== entries.length || catalogPages.some(page => page.catalog_version !== first.catalog_version)) throw new Error('Incomplete or changed Charms catalog.');
        const skills = [];
        for (const entry of entries) {
          const old = previous?.skills.find(skill => skill.name === entry.name);
          if (old && old.version === entry.charm_version && !['kineto.connections', 'kineto.agents'].includes(entry.name)) {
            skills.push({ ...old, description: entry.description });
            continue;
          }
          if (!/^[\w.-]+$/.test(entry.name)) throw new Error('Invalid Charms skill name.');
          const parts = await pages('charms_skill_load', { name: entry.name }, signal);
          const body = parts.map((page, index) => index === 0 ? page.skill_md : page.content).join('');
          if (parts.some((page, index) => typeof (index === 0 ? page.skill_md : page.content) !== 'string')) throw new Error('Invalid Charms skill body.');
          skills.push({ name: entry.name, description: entry.description,
            path: entry.name + '/SKILL.md', version: entry.charm_version,
            content: `Remote skill directory: ${parts[0].path}\nSupporting files and scripts live in the Charms sandbox. Read them with the remote read tool; execute them with remote exec.\n\n${body}` });
        }
        return { revision: String(first.catalog_version), skills };
      },
    },
  };
})();
