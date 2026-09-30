import type { IFileSystem } from 'just-bash/browser';
import type { Skill } from './types';

/** Local SKILL.md files use the familiar name/description YAML frontmatter subset. */
export async function localSkills(fs: IFileSystem): Promise<Skill[]> {
  const skills: Skill[] = [];
  const walk = async (path: string, depth = 0): Promise<void> => {
    if (depth > 8) return;
    let names: string[];
    try {
      names = await fs.readdir(path);
    } catch {
      return;
    }
    for (const name of names) {
      const file = path + '/' + name;
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink) continue;
      if (stat.isDirectory) {
        await walk(file, depth + 1);
        continue;
      }
      if (name !== 'SKILL.md' || skills.length >= 500) continue;
      const content = await fs.readFile(file);
      const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)?.[1];
      if (!header) continue;
      const scalar = (key: string) => {
        const value = new RegExp('^' + key + ':\\s*(.*)$', 'm').exec(header)?.[1];
        if (!value) return '';
        if (/^[>|][-+]?$/.test(value))
          return (
            new RegExp('^' + key + ':.*\\n((?:[ \\t]+.*(?:\\n|$))+)', 'm')
              .exec(header)?.[1]
              .trim()
              .replace(/\s+/g, ' ') ?? ''
          );
        return value.replace(/^['"]|['"]$/g, '');
      };
      const skillName = scalar('name'),
        description = scalar('description');
      if (skillName && description)
        skills.push({ name: skillName, description, path: file, content });
    }
  };
  await walk('/workspace/skills');
  return skills;
}
