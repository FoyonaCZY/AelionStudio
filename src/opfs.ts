const ROOT = 'aelion-studio';
const MEDIA = 'media';

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  if (index < 0) return '';
  const ext = name.slice(index).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/u.test(ext) ? ext : '';
}

async function mediaDirectory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  const studio = await root.getDirectoryHandle(ROOT, { create: true });
  return studio.getDirectoryHandle(MEDIA, { create: true });
}

export function opfsAvailable(): boolean {
  return typeof navigator.storage.getDirectory === 'function';
}

export async function cacheMediaFile(assetId: string, file: File): Promise<string | undefined> {
  if (!opfsAvailable()) return undefined;
  const directory = await mediaDirectory();
  const fileName = `${assetId}${extensionOf(file.name)}`;
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file);
  await writable.close();
  return `${ROOT}/${MEDIA}/${fileName}`;
}

export async function readCachedMedia(path: string): Promise<File | undefined> {
  if (!opfsAvailable()) return undefined;
  const parts = path.split('/');
  if (parts[0] !== ROOT || parts[1] !== MEDIA || parts[2] === undefined || parts.length !== 3) {
    return undefined;
  }
  try {
    const directory = await mediaDirectory();
    const handle = await directory.getFileHandle(parts[2]);
    return await handle.getFile();
  } catch {
    return undefined;
  }
}
