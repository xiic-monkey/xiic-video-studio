/**
 * 读剪贴板里的图片。
 *
 * 走 `paste` 事件：用户按 Cmd+V 时浏览器把剪贴板内容交给页面，
 * 里面带图片就能取出字节。落盘成项目素材由后端做。
 */

/**
 * 剪贴板里有没有图片。
 *
 * 看 items 而不是只看 types：文件项在 items 里的 type 才是真实 MIME，
 * types 里对文件项只报一个 'Files'。
 */
export function hasImageInDataTransfer(data: DataTransfer | null): boolean {
  if (!data) return false;
  const items = Array.from(data.items ?? []);
  if (items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return true;
  return Array.from(data.types ?? []).some((type) => type.startsWith('image/'));
}

/** 从一个 DataTransfer（粘贴事件）里取图片字节。 */
export async function imageBytesFromDataTransfer(data: DataTransfer | null): Promise<Uint8Array | undefined> {
  if (!data) return undefined;
  const items = Array.from(data.items ?? []);
  for (const item of items) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (!file) continue;
    return new Uint8Array(await file.arrayBuffer());
  }
  const files = Array.from(data.files ?? []);
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    return new Uint8Array(await file.arrayBuffer());
  }
  return undefined;
}

/** 字节 → base64（后端按 base64 收，省得传大数组）。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
