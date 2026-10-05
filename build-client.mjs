import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const { build } = createRequire(import.meta.url)(process.env.DSH_HISTORY_BUILD_TOOLS || 'esbuild');
const result = await build({ entryPoints: [join(root, 'client-src/index.js')], bundle: true, format: 'cjs', platform: 'browser',
  target: ['chrome100'], charset: 'utf8', external: ['react', 'react-dom'], write: false, legalComments: 'none' });
await writeFile(join(root, 'client.js'), `window.__ModuleLoader__.load({id:'dsh-credit-history',factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;}});\n`, 'utf8');
console.log('已构建独立积分历史页面');
