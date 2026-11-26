const RESERVED = /[\\/:*?"<>|]/g;

/**
 * 把项目名变成一个跨平台可写的导出文件名。
 *
 * 保留字符（`\ / : * ? " < > |`）在 Windows/macOS 上都会导致写入失败或语义歧义，
 * 统一换成下划线；空白也换成下划线，避免路径里出现空格。
 *
 * 末尾拼项目 id 的后 6 位：同名项目导出到同一目录时不会互相覆盖，
 * 同时保留足够短，文件名总长可控。
 */
export function safeExportName(project: { name: string; id: string }): string {
  const cleaned = project.name
    .replace(RESERVED, '_')
    .replace(/\s+/g, '_')
    .slice(0, 48)
    .replace(/^_+|_+$/g, '');
  const base = cleaned || 'frameforge-project';
  const tail = project.id.slice(-6);
  return tail ? `${base}-${tail}.json` : `${base}.json`;
}

/**
 * 含素材导出时的目录名：和 `safeExportName` 同一套清洗规则，只是不带 .json 后缀。
 *
 * 目录名带项目 id 尾段：同名项目导出到同一父目录时不会互相覆盖。
 */
export function safeExportDirName(project: { name: string; id: string }): string {
  return safeExportName(project).replace(/\.json$/, '');
}
