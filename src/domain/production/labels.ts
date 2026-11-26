/**
 * 制作数据的枚举值 → 中文。
 *
 * 后端存的是英文枚举（review: draft、subject kind: character），
 * 前端直接渲染会让界面中英混排。这里集中给出中文名，
 * 英文只保留在开发者视图与日志里。
 */

/** 审批状态。 */
export const REVIEW_LABEL: Record<string, string> = {
  draft: '草稿',
  review: '待审',
  approved: '已通过',
  rejected: '已驳回',
};

export function reviewLabel(state: unknown): string {
  const key = String(state ?? 'draft');
  return REVIEW_LABEL[key] ?? key;
}

/** 主体类型。 */
export const SUBJECT_KIND_LABEL: Record<string, string> = {
  character: '角色',
  location: '地点',
  prop: '道具',
};

export function subjectKindLabel(kind: unknown): string {
  const key = String(kind ?? 'character');
  return SUBJECT_KIND_LABEL[key] ?? key;
}

/** 节点类别（Inspector 顶部的 eyebrow）。 */
export const NODE_CATEGORY_LABEL: Record<string, string> = {
  media: '媒体',
  audio: '音频',
  script: '剧本',
  utility: '工具',
  character: '角色',
  shot: '镜头',
  scene: '场景',
};

export function nodeCategoryLabel(category: unknown): string {
  const key = String(category ?? '');
  return NODE_CATEGORY_LABEL[key] ?? key;
}

/** Key 状态（设置页）。 */
export const KEY_STATUS_LABEL: Record<string, string> = {
  active: '可用',
  invalid: '已失效',
};

export function keyStatusLabel(status: unknown, hasSecret: boolean): string {
  if (!hasSecret) return '未保存';
  return KEY_STATUS_LABEL[String(status ?? 'active')] ?? String(status);
}
