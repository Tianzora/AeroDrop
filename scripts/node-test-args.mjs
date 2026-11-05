import { readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const tsxLoaderPath = pathToFileURL(resolve(scriptDir, '../node_modules/tsx/dist/loader.mjs')).href;

// Pure helpers only: importing this module must never start a test run.
export const buildNodeTestArgs = (files) => ['--import', tsxLoaderPath, '--test', ...files];

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
