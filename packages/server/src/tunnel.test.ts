// packages/server/src/tunnel.test.ts
import { describe, expect, it } from 'vitest';
import { parseTunnelUrl } from './tunnel.ts';

describe('parseTunnelUrl', () => {
  it('从 cloudflared 输出中解析 trycloudflare 域名', () => {
    const output = `
Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):
https://random-words-1234.trycloudflare.com
`;
    expect(parseTunnelUrl(output)).toBe('https://random-words-1234.trycloudflare.com');
  });

  it('输出中无域名时返回 null', () => {
    expect(parseTunnelUrl('tunnel failed to start')).toBeNull();
  });
});
