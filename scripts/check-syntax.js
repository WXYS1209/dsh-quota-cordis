// Parse every shipped Host/Client entry and maintenance script without executing plugin code.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const list = directory => readdirSync(join(root, directory), { recursive: true })
  .filter(name => name.endsWith('.js'))
  .map(name => `${directory}/${String(name).replaceAll('\\', '/')}`)
  .sort();
const files = ['index.js', 'client.js', ...list('src'), ...list('scripts')];
for (const file of files) execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'inherit' });
console.log(`Checked ${files.length} JavaScript files`);
