import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tsxLoaderPath = pathToFileURL(resolve(scriptDir, '../node_modules/tsx/dist/loader.mjs')).href;
const testStubRegisterPath = pathToFileURL(resolve(scriptDir, 'test-stubs/register.mjs')).href;

// Pure helpers only: importing this module must never start a test run.
export const buildNodeTestArgs = (files) => [
  // tsx 负责 TS/JSX 转译；test-stubs 把只在浏览器里做视觉效果的大 barrel 依赖
  // （motion/react、@hugeicons/*）换成本地极简实现，避免每个测试子进程重复转译。
  '--import',
  tsxLoaderPath,
  '--import',
  testStubRegisterPath,
  '--test',
  ...files,
];

export const collectTestFiles = (targets) => {
  const discovered = new Set();

  const collect = (targetPath) => {
    const resolvedPath = resolve(targetPath);
    const stats = statSync(resolvedPath, { throwIfNoEntry: false });

    if (!stats) {
      throw new Error(`Test target not found: ${resolvedPath}`);
    }

    if (stats.isDirectory()) {
      for (const entry of readdirSync(resolvedPath, { withFileTypes: true })) {
        collect(resolve(resolvedPath, entry.name));
      }
      return;
    }

    if (resolvedPath.endsWith('.test.ts')) {
      discovered.add(resolvedPath);
    }
  };

  for (const target of targets) {
    collect(target);
  }

  const testFiles = Array.from(discovered).sort();

  if (testFiles.length === 0) {
    throw new Error(`No test files found for targets: ${targets.join(', ')}`);
  }

  return testFiles;
};
