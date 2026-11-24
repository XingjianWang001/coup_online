import { readFile } from 'node:fs/promises';

// .private-credits 放不进公开仓库的按域名配置：署名名单 roster.json 与站点设置 sites.json。部署脚本经 SSH 单独上传，见 docs/deployment.md。
interface Credit {
  name: string;
  contribution: string;
}

type Roster = Record<string, { 'zh-CN': Credit[]; en: Credit[] }>;

interface Filing {
  icp: string;
  police?: { code: string; label: string };
}

// 文件内容不可信，逐项校验后才交给前端
type Sites = Record<string, { filing?: { icp?: unknown; police?: { code?: unknown; label?: unknown } }; cardStyles?: unknown }>;

// 本地开发和 ui-check 没有 sites.json，也要能看到牌面风格切换
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

async function readPrivate<T extends object>(file: string): Promise<T | Record<string, never>> {
  try {
    const data = JSON.parse(await readFile(new URL(`../../../.private-credits/${file}`, import.meta.url), 'utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`Could not read the private ${file}.`);
    return {};
  }
}

export const readRoster = () => readPrivate<Roster>('roster.json');
export const readSites = () => readPrivate<Sites>('sites.json');

const hostnameOf = (host: string) => host.split(':')[0].toLowerCase();

export function creditsFor(roster: Roster, host: string, locale: string | null): Credit[] {
  const hostname = hostnameOf(host);
  const site = roster[Object.hasOwn(roster, hostname) ? hostname : '*'];
  const rows = site?.[locale === 'zh-CN' ? 'zh-CN' : 'en'];
  if (!Array.isArray(rows)) return [];
  return rows.filter(row => typeof row?.name === 'string' && typeof row.contribution === 'string')
    .map(({ name, contribution }) => ({ name, contribution }));
}

// 备案号没有默认值：未登记的域名（含 localhost、SSH 隧道）不显示页脚
export function siteFor(sites: Sites, host: string): { filing?: Filing; cardStyles: boolean } {
  const hostname = hostnameOf(host);
  const site = Object.hasOwn(sites, hostname) ? sites[hostname] : undefined;
  const { icp, police } = site?.filing ?? {};
  const filing = typeof icp === 'string'
    ? { icp, ...(typeof police?.code === 'string' && typeof police.label === 'string' && { police: { code: police.code, label: police.label } }) }
    : undefined;
  return { ...(filing && { filing }), cardStyles: site?.cardStyles === true || LOCAL_HOSTS.includes(hostname) };
}
