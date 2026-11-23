import { readFile } from 'node:fs/promises';

interface Credit {
  name: string;
  contribution: string;
}

type Roster = Record<string, { 'zh-CN': Credit[]; en: Credit[] }>;

export async function readRoster(): Promise<Roster> {
  try {
    const roster = JSON.parse(await readFile(new URL('../../../.private-credits/roster.json', import.meta.url), 'utf8'));
    return roster && typeof roster === 'object' && !Array.isArray(roster) ? roster : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Could not read the private credits roster.');
    return {};
  }
}

export function creditsFor(roster: Roster, host: string, locale: string | null): Credit[] {
  const hostname = host.split(':')[0].toLowerCase();
  const site = roster[Object.hasOwn(roster, hostname) ? hostname : '*'];
  const rows = site?.[locale === 'zh-CN' ? 'zh-CN' : 'en'];
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => typeof row?.name === 'string' && typeof row.contribution === 'string')
    .map(({ name, contribution }) => ({ name, contribution }));
}
