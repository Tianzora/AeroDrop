// `node:sqlite` 适配器，把 Durable Object 的 SQL 接口映射到真实的 SQLite。
//
// 为什么放在 scripts/test-stubs/：这是测试基建，不是业务代码；覆盖率统计默认排除
// 本目录，避免「测试辅助文件」虚增分母。真实 SQLite 的意义是让「语句本身能否执行」
// 也被覆盖 —— 只认前缀的 fake SQL 看不见列序写错、RETURNING 在 ON CONFLICT DO
// NOTHING 下不返回行这类错误。
//
// 语义按 Workers 收紧：一次 exec 只执行一条语句；`rowsWritten` 取 `changes()`
// （实际写入行数），不是 RETURNING 的行数 —— 两者在 `ON CONFLICT DO NOTHING`
// 时会分叉，用行数会掩盖「什么都没写」。

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export type TestSql = {
  exec<T = Record<string, unknown>>(
    text: string,
    ...params: unknown[]
  ): { toArray(): T[]; rowsWritten: number };
};

export const createSqlite = (db: DatabaseSync): TestSql => ({
  exec<T = Record<string, unknown>>(text: string, ...params: unknown[]) {
    const withoutTrailing = text.trim().replace(/;+$/, '');
    if (withoutTrailing.includes(';')) {
      throw new Error(`sqlite test adapter only executes a single statement: ${text}`);
    }
    const statement = db.prepare(text);
    const returnsRows = /^\s*(SELECT|PRAGMA|WITH)/i.test(text) || /\bRETURNING\b/i.test(text);
    if (returnsRows) {
      const rows = statement.all(...(params as SQLInputValue[])) as T[];
      const changes = db.prepare('SELECT changes() AS count').get() as { count: number };
      return { toArray: () => rows, rowsWritten: Number(changes.count) };
    }
    const info = statement.run(...(params as SQLInputValue[]));
    return { toArray: () => [] as T[], rowsWritten: Number(info.changes) };
  },
});
