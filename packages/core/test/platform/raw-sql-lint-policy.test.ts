import { join } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const packageRoot = join(import.meta.dirname, '..', '..');

async function rawSqlFindings(relativePath: string, code: string): Promise<string[]> {
  // Only the syntactic raw-SQL rule runs, so the virtual file needs no TypeScript project.
  const eslint = new ESLint({
    cwd: packageRoot,
    ruleFilter: ({ ruleId }) => ruleId === 'no-restricted-properties',
    overrideConfig: { languageOptions: { parserOptions: { projectService: false } } },
  });
  const [result] = await eslint.lintText(code, { filePath: join(packageRoot, relativePath) });
  const messages = result?.messages ?? [];
  expect(messages.filter((m) => m.fatal === true)).toEqual([]);
  return messages.map((m) => m.message);
}

const snippet = (call: string) => `import type { PrismaClient } from '@company-ops/db';
export async function probe(prisma: PrismaClient): Promise<unknown> {
  return ${call};
}
`;

// The first lint loads the whole ESLint config, which exceeds the default timeout when CI runs tasks in parallel.
describe('raw SQL lint policy (ARCHITECTURE §10)', { timeout: 30_000 }, () => {
  it('bans tagged and unsafe raw SQL in application code', async () => {
    expect(await rawSqlFindings('src/modules/probe.ts', snippet('prisma.$queryRaw`SELECT 1`'))).toHaveLength(1);
    expect(await rawSqlFindings('src/modules/probe.ts', snippet("prisma.$queryRawUnsafe('SELECT 1')"))).toHaveLength(1);
    expect(await rawSqlFindings('src/modules/probe.ts', snippet("prisma.$executeRawUnsafe('SELECT 1')"))).toHaveLength(
      1,
    );
  });

  it('allows only tagged raw SQL inside platform/db/sql', async () => {
    expect(await rawSqlFindings('src/platform/db/sql/probe.ts', snippet('prisma.$queryRaw`SELECT 1`'))).toHaveLength(0);
    expect(
      await rawSqlFindings('src/platform/db/sql/probe.ts', snippet("prisma.$queryRawUnsafe('SELECT 1')")),
    ).toHaveLength(1);
  });

  it('keeps tagged raw SQL banned in security tests', async () => {
    expect(
      await rawSqlFindings('test/x/probe.security.int.test.ts', snippet('prisma.$queryRaw`SELECT 1`')),
    ).toHaveLength(1);
  });
});
