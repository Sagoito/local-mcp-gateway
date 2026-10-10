import { copyFile, mkdir, rm } from 'node:fs/promises';

const output = new URL('../dist/web/', import.meta.url);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'app.js', 'style.css'])
  await copyFile(
    new URL(`../web/${name}`, import.meta.url),
    new URL(name, output),
  );
