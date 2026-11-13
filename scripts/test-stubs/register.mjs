// 用 `node --import ./scripts/test-stubs/register.mjs --test ...` 启用。
import { register } from 'node:module';

register('./stub-loader.mjs', import.meta.url);
