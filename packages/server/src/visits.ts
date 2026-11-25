import { createHmac, randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { IP2Region } from 'ip2region/node';
import { appendRecord, dataPath } from './data-file.ts';

// 漏斗上的四种事件；进房分经加入链接和手输房间码
export type Visit = { event: 'home' | 'createRoom' | 'startGame' } | { event: 'joinRoom'; via: 'link' | 'code' };

// 一条访问只有小时、事件、地区和当天的访客哈希：不写 IP，也不写昵称、房间码。写失败只打日志
export function recordVisit(ip: string, visit: Visit, now = new Date()): Promise<void> {
  const time = beijing(now);
  const record = { at: `${time.slice(0, 13)}:00+08:00`, ...visit, region: regionOf(ip), visitor: visitorOf(ip, now) };
  return appendRecord(`visits-${time.slice(0, 10)}.jsonl`, record).catch((error) => console.error('visit write error', error));
}

// 北京时间（UTC+8）的 ISO 串：前 10 位是日期，前 13 位精确到小时
const beijing = (now: Date) => new Date(now.getTime() + 8 * 3_600_000).toISOString();

// 独立访客：IP 的 HMAC，密钥按北京时间每天一换，只在内存里。跨天、跨重启都认不出同一个人
let key = { day: '', secret: Buffer.alloc(0) };
export function visitorOf(ip: string, now: Date): string {
  const day = beijing(now).slice(0, 10);
  if (key.day !== day) key = { day, secret: randomBytes(32) };
  return createHmac('sha256', key.secret).update(ip).digest('hex').slice(0, 16);
}

// 访问（ADR 0015）：写入时把 IP 换成地区后丢掉。内置的 IPv4 + IPv6 数据库约 48 MB，启动时同步读进内存
const regions = new IP2Region({ mappedIPv6: 'ipv4' });

// 国内到市，国外到国家。回环和内网地址（SSH 隧道经 Docker 网关进来）记为本机
export function regionOf(ip: string): string {
  let hit;
  try {
    hit = regions.lookup(ip);
  } catch {
    return '未知'; // 不是合法 IP（如伪造的 X-Forwarded-For）
  }
  if (ip === '::1' || String(hit?.extensions?.region).startsWith('Reserved|')) return '本机';
  if (!hit?.country?.name) return '未知';
  return hit.country.code === 'CN' ? (hit.city?.name ?? hit.subdivisions?.[0]?.name ?? hit.country.name) : hit.country.name;
}

// 只留最近 90 天（含今天）的按天文件，更早的整个删掉。文件名里的日期是北京时间，按字符串比较即可
export async function pruneVisits(now = new Date()): Promise<void> {
  const oldest = beijing(new Date(now.getTime() - 89 * 86_400_000)).slice(0, 10);
  const names = await readdir(dataPath('')).catch(() => []);
  for (const name of names) {
    const day = /^visits-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (day && day < oldest) await rm(dataPath(name), { force: true });
  }
}
