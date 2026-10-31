import { open } from '@tauri-apps/plugin-dialog';
import type { LegacyImportResult } from '../services/tauri';

/** 总结里最多列出的告警条数，其余只报数量。 */
const WARNING_PREVIEW = 4;

export async function pickLegacyFile(): Promise<string | undefined> {
  const picked = await open({
    multiple: false,
    directory: false,
    title: '选择旧项目 JSON',
    filters: [{ name: '旧项目 JSON', extensions: ['json'] }],
  });
  return typeof picked === 'string' ? picked : undefined;
}

export function summarizeImport(result: LegacyImportResult): string {
  if (!result.warnings.length) {
    if (!result.assetCount) return '没有导入任何素材：旧项目可能还没有生成结果。';
    return `导入 ${result.assetCount} 个素材，生成 ${result.runCount} 条导入记录，没有告警。`;
  }
  const head = result.warnings.slice(0, WARNING_PREVIEW).join('；');
  const rest = result.warnings.length - WARNING_PREVIEW;
  return `导入 ${result.assetCount} 个素材，生成 ${result.runCount} 条导入记录。告警：${head}${rest > 0 ? `（还有 ${rest} 条）` : ''}`;
}
