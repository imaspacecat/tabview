import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    const name = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await collect(path, `${name}/`);
    else if (entry.isFile()) files[name] = await readFile(path);
    else throw new Error(`Unsupported entry in extension build: ${path}`);
  }
}
await collect('dist');
await mkdir('artifacts', { recursive: true });
const destination = `artifacts/tabview-${manifest.version}.zip`;
await writeFile(destination, zipSync(files, { level: 9 }));
console.log(`Unsigned extension package: ${destination}`);
