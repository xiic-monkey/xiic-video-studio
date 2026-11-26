import type { ProductionEntity } from '../../services/tauri';

/** 读取制作实体载荷里的字符串字段。 */
export function payloadText(entity: ProductionEntity | undefined, key: string): string {
  const value = entity?.payload?.[key];
  return typeof value === 'string' ? value : '';
}
