import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import type { Plugin } from 'vite';

interface IconManifest {
  iconDefinitions: Record<string, { iconPath: string }>;
  fileExtensions: Record<string, string>;
  fileNames: Record<string, string>;
  folderNames: Record<string, string>;
  file: string;
  folder: string;
  folderExpanded: string;
}

const ID = 'virtual:file-icons';
const RESOLVED = `\0${ID}`;

export const ICON_PACKAGE_DIR = dirname(createRequire(import.meta.url).resolve('material-icon-theme/package.json'));

/** True for the SVGs this plugin imports, so Vite emits them as files instead of inlining them into the bundle. */
export const isIconAsset = (file: string) => file.startsWith(join(ICON_PACKAGE_DIR, 'icons'));

const lower = (map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Exposes the Material Icon Theme mappings as `virtual:file-icons`: the extension, file-name and folder-name tables
 * plus a URL for every icon they reference (dark variants only).
 */
export function fileIcons(): Plugin {
  return {
    name: 'file-icons',
    resolveId: (id) => (id === ID ? RESOLVED : undefined),
    load(id) {
      if (id !== RESOLVED) return undefined;
      const m = JSON.parse(readFileSync(join(ICON_PACKAGE_DIR, 'dist/material-icons.json'), 'utf8')) as IconManifest;
      const folderIcons = new Set([m.folder, ...Object.values(m.folderNames)]);
      const used = new Set([m.file, ...Object.values(m.fileExtensions), ...Object.values(m.fileNames), ...folderIcons, ...[...folderIcons].map((n) => `${n}-open`)]);
      const names = [...used].filter((n) => m.iconDefinitions[n]);
      const imports = names.map((n, i) => `import i${i} from ${JSON.stringify(`${join(ICON_PACKAGE_DIR, 'icons', basename(m.iconDefinitions[n]!.iconPath))}?url`)};`);
      const urls = names.map((n, i) => `${JSON.stringify(n)}:i${i}`).join(',');
      const tables = { fileExtensions: lower(m.fileExtensions), fileNames: lower(m.fileNames), folderNames: lower(m.folderNames), file: m.file, folder: m.folder };
      return `${imports.join('\n')}\nexport const urls = {${urls}};\nexport const tables = ${JSON.stringify(tables)};\n`;
    },
  };
}
