export function taskLabel(name: string, complete = false): string {
  switch (name.split(' · ')[0]) {
    case 'write':
      return complete ? 'Created a file' : 'Creating your file';
    case 'edit':
      return complete ? 'Updated a file' : 'Updating your file';
    case 'read':
      return complete ? 'Read a file' : 'Reading your file';
    case 'list':
      return complete ? 'Checked your files' : 'Looking through your files';
    case 'read_skill':
      return complete ? 'Checked instructions' : 'Checking instructions';
    case 'automation':
      return complete ? 'Updated a routine' : 'Updating your routine';
    case 'background':
      return complete ? 'Started background work' : 'Starting background work';
    default:
      return complete ? 'Completed a step' : 'Working on your request';
  }
}
