import { spawnSync } from 'node:child_process';

import { buildNodeTestArgs, collectTestFiles } from './node-test-args.mjs';

const rawTargets = process.argv.slice(2);
const targets = rawTargets.length > 0 ? rawTargets : ['services'];

const result = spawnSync(
  process.execPath,
  buildNodeTestArgs(collectTestFiles(targets)),
  {
    stdio: 'inherit',
  }
);

if (typeof result.status === 'number') {
  process.exit(result.status);
}

if (result.error) {
  throw result.error;
}

process.exit(1);
