import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// 运营数据（ADR 0015）：数据目录下的 JSONL 文件，一行一条，只追加。相对路径按进程工作目录解析
export const dataPath = (name: string) => join(process.env.DATA_DIR ?? 'data', name);

export async function appendRecord(name: string, record: unknown): Promise<void> {
  await mkdir(dataPath(''), { recursive: true });
  await appendFile(dataPath(name), `${JSON.stringify(record)}\n`);
}

// 跳过解析不了的行：进程崩溃时最后一行可能只写了一半。文件还不存在时没有记录
export async function readRecords(name: string): Promise<unknown[]> {
  let text: string;
  try {
    text = await readFile(dataPath(name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return text.split('\n').flatMap((line) => {
    try {
      return line ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
}
