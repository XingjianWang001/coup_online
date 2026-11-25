// 重新生成衬线展示字体子集：取 serifText() 列出的字，向 Google Fonts 要只含这些字形的 Noto Serif SC 600，
// 写到 packages/client/public/fonts/noto-serif-sc-600.woff2，打进去的字记在同名 .txt（serifGlyphs.test.ts 核对）。
// 用法：node scripts/serif-subset.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serifText } from '../packages/client/src/serifGlyphs.ts';

const FONTS = resolve(import.meta.dirname, '../packages/client/public/fonts');
const text = serifText();
// 带浏览器 UA，Google 才返回 woff2
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const css = await (await fetch(`https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@600&text=${encodeURIComponent(text)}`, { headers: { 'User-Agent': UA } })).text();
const url = /url\((https:[^)]+)\)\s*format\('woff2'\)/.exec(css)?.[1];
if (!url) throw new Error(`没有拿到 woff2：\n${css}`);
const font = Buffer.from(await (await fetch(url)).arrayBuffer());
writeFileSync(resolve(FONTS, 'noto-serif-sc-600.woff2'), font);
writeFileSync(resolve(FONTS, 'noto-serif-sc-600.txt'), text + '\n');
console.log(`${[...text].length} 字，${(font.length / 1024).toFixed(1)} KB`);
