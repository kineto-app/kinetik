/** Namespace prefixes are transport details, not useful action labels. */
export function taskKind(name: string): string {
  const parts = name.split(' · ');
  const tool = parts[0] === 'App' ? (parts[1] ?? 'app') : parts[0];
  const bare = tool
    .split('__')
    .at(-1)!
    .replace(/^charms_/, '');
  return (
    (
      {
        files_read: 'read',
        files_write: 'write',
        files_edit: 'edit',
        files_list: 'list',
        skill_load: 'read_skill',
        skill_find: 'find_skill',
      } as Record<string, string>
    )[bare] ?? bare
  );
}

export function taskLabel(name: string, complete = false, count = 1): string {
  const many = count > 1;
  switch (taskKind(name)) {
    case 'exec':
      return complete ? (many ? `Ran ${count} commands` : 'Ran a command') : 'Running a command';
    case 'show_file':
      return complete ? (many ? `Shared ${count} files` : 'Shared a file') : 'Sharing a file';
    case 'write':
      return complete ? (many ? `Saved ${count} files` : 'Saved a file') : 'Saving a file';
    case 'edit':
      return complete ? (many ? `Updated ${count} files` : 'Updated a file') : 'Updating a file';
    case 'read':
      return complete ? (many ? `Read ${count} files` : 'Read a file') : 'Reading a file';
    case 'list':
      return complete ? 'Checked your files' : 'Looking through your files';
    case 'read_skill':
      return complete ? 'Read instructions' : 'Reading instructions';
    case 'find_skill':
      return complete ? 'Found instructions' : 'Finding instructions';
    case 'render':
      return complete
        ? many
          ? `Prepared ${count} previews`
          : 'Prepared preview'
        : 'Preparing preview';
    case 'job':
      return complete ? 'Checked background work' : 'Checking background work';
    case 'job_cancel':
      return complete ? 'Requested cancellation' : 'Requesting cancellation';
    case 'automation':
      return complete ? 'Updated a routine' : 'Updating your routine';
    case 'background':
      return complete ? 'Started background work' : 'Starting background work';
    default: {
      const title = taskKind(name).replace(/[_-]+/g, ' ').trim();
      return title ? title[0].toUpperCase() + title.slice(1) : 'Tool activity';
    }
  }
}

/** Neutral wording for failed or uncertain actions; never suggest they are still running. */
export function taskAction(name: string): string {
  return (
    (
      {
        exec: 'Run command',
        read: 'Read file',
        write: 'Save file',
        show_file: 'Share file',
        edit: 'Update file',
        list: 'List files',
        read_skill: 'Read instructions',
        find_skill: 'Find instructions',
        render: 'Prepare preview',
      } as Record<string, string>
    )[taskKind(name)] ?? taskLabel(name)
  );
}
