import { tables, urls } from 'virtual:file-icons';

const baseName = (path: string) => (path.split('/').pop() ?? path).toLowerCase();

/** Same lookup order as VS Code file icon themes: exact file name, then the longest matching extension. */
function fileIconName(path: string): string {
  const name = baseName(path);
  const exact = tables.fileNames[name];
  if (exact) return exact;
  for (let i = name.indexOf('.'); i !== -1; i = name.indexOf('.', i + 1)) {
    const icon = tables.fileExtensions[name.slice(i + 1)];
    if (icon) return icon;
  }
  return tables.file;
}

function folderIconName(path: string, open: boolean): string {
  const icon = tables.folderNames[baseName(path)] ?? tables.folder;
  return open && urls[`${icon}-open`] ? `${icon}-open` : icon;
}

function IconImg({ name, size }: { name: string; size: number }) {
  return <img src={urls[name]} alt="" aria-hidden="true" width={size} height={size} draggable={false} className="flex-none select-none" style={{ width: size, height: size }} />;
}

export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  return <IconImg name={fileIconName(path)} size={size} />;
}

export function FolderIcon({ path, open, size = 16 }: { path: string; open: boolean; size?: number }) {
  return <IconImg name={folderIconName(path, open)} size={size} />;
}
