import type { BoardNode } from '../types';

/**
 * 业务化节点的提示词模板。
 *
 * 这些节点不是新协议：它们只是「通用能力 + 固定版式约束」的组合，
 * 内部仍然调用 image.generate / image.edit / text.chat。
 */

function layoutInstruction(node: BoardNode): string {
  const layout = String((node.data as { layout?: string }).layout ?? 'landscape');
  if (layout === 'portrait') {
    return [
      '角色设定图，竖版 2×2 四视图：左上正面全身、右上左侧四分之三侧身、左下右侧四分之三侧身、右下背面全身，',
      '四格等高对齐、同一个人、同一套服装与发型。',
    ].join('');
  }
  return [
    '角色设定图，横版：左侧 1/3 放大幅面部特写，右侧依次排列正面全身、侧面四分之三（只露出一只眼睛）、背面全身，',
    '三个全身等高对齐、同一个人、同一套服装与发型。',
  ].join('');
}

/** 角色三视图的版式与一致性约束。 */
export function characterSheetInstruction(node: BoardNode): string {
  const background = String((node.data as { background?: string }).background ?? 'white');
  const backgroundText = background === 'gray' ? '浅灰色无影背景' : '纯白色无缝背景';
  return [
    '（角色设定图规范）',
    layoutInstruction(node),
    `${backgroundText}，柔和均匀的棚拍布光，无投影干扰；`,
    '正面双眼对称，侧面只露一只眼睛，背面不画脸；全身像不裁头不裁脚；',
    '不要文字、标签、箭头、水印、边框、道具与场景。',
  ].join('');
}

/** 分镜九宫格的版式约束。 */
export function storyboardGridInstruction(node: BoardNode): string {
  const grid = String((node.data as { grid?: string }).grid ?? '3x3');
  const count = grid === '4x4' ? 16 : 9;
  return [
    `（分镜${grid}规范）`,
    `一张图内排 ${count} 个连续镜头分镜画格，等宽等高、留细白缝分隔；`,
    '同一场景、同一角色、同一光线，从建立镜头逐步推进到近景，构图与景别依次变化；',
    '每格独立完整，不要文字、镜头编号、标签与水印。',
  ].join('');
}

/** 表情九宫格：同一角色的九种表情。 */
export function expressionSheetInstruction(node: BoardNode): string {
  const preset = String((node.data as { variant?: string }).variant ?? 'happy');
  const emotions: Record<string, string> = {
    happy: '开心、惊讶、愤怒、悲伤、恐惧、厌恶、平静、坚定、疲惫',
    calm: '中性、微笑、轻蔑、困惑、担心、得意、无语、冷笑、释然',
    dramatic: '怒吼、狂喜、崩溃、绝望、仇恨、贪婪、虔诚、疯癫、麻木',
  };
  const list = emotions[preset] ?? emotions.happy;
  return [
    '（表情九宫格规范）',
    `一张图内排 9 格面部特写，依次为：${list}；`,
    '九格都是同一个人的正面特写，身份、发型、服装、背景、光线完全一致，只改表情；',
    '纯白背景，肩部以上构图，不要文字、标签与水印。',
  ].join('');
}

/** 造型变体：只改一项，身份不变。 */
export function variantSheetInstruction(node: BoardNode): string {
  const kind = String((node.data as { variant?: string }).variant ?? 'outfit');
  const note = String((node.data as { note?: string }).note ?? '').trim();
  const labels: Record<string, string> = {
    outfit: '服装变体',
    age: '年龄变体',
    battle: '战损变体',
    makeup: '妆造变体',
  };
  const label = labels[kind] ?? '造型变体';
  return [
    `（${label}规范）`,
    '同一角色的设定图变体：脸型、五官、发型特征保持可辨认地一致，只改变造型部分；',
    note ? `变体要求：${note}；` : '',
    '纯白背景，柔和棚拍光，正面全身加面部特写；不要文字、标签与水印。',
  ].join('');
}

/** 360 转面序列。 */
export function turnaroundInstruction(node: BoardNode): string {
  const steps = Math.max(4, Math.min(24, Number((node.data as { steps?: number }).steps ?? 8)));
  return [
    '（360 度转面规范）',
    `一张图内排 ${steps} 个等高对齐的全身像，角色按均匀角度连续转身一周（正面 → 四分之三 → 侧面 → 背面 → 另一侧 → 正面）；`,
    '每个角度都是同一个人、同一套服装、同一光线；纯白背景；不要文字、角度标注与水印。',
  ].join('');
}

/** 场景多机位。 */
export function coverageInstruction(node: BoardNode): string {
  const grid = String((node.data as { grid?: string }).grid ?? '3x3');
  const count = grid === '4x4' ? 16 : 9;
  return [
    `（多机位${grid}规范）`,
    `一张图内排 ${count} 格同一场景的多机位画面：远景、全景、中景、近景、特写交替，机位高度与角度各不相同；`,
    '场景布局、道具位置、光线方向与时间保持一致，只换机位与景别；不要文字、镜头编号与水印。',
  ].join('');
}

/** 剧情推演四宫格。 */
export function continuityInstruction(node: BoardNode): string {
  const direction = String((node.data as { variant?: string }).variant ?? 'before-after');
  const labels: Record<string, string> = {
    'before-after': '前 3 秒 / 当前 / 后 3 秒',
    sequence: '前序 / 过程 / 后续 / 结果',
  };
  const label = labels[direction] ?? labels['before-after'];
  return [
    '（连续性推演规范）',
    `一张图内排 4 格连续画面，依次为：${label}；`,
    '同一场景、同一角色、同一服装与光线，构图连续、动作衔接自然；不要文字、时间戳与水印。',
  ].join('');
}

/** 重绘：保持原图，只改指定内容。 */
export function redrawInstruction(node: BoardNode): string {
  const note = String((node.data as { note?: string }).note ?? '').trim();
  return [
    '（重绘规范）',
    '保持参考图的构图、视角、光线与风格不变，只修改明确指出的部分，未提及的部分不要改动。',
    note ? `修改要求：${note}；` : '',
  ].join('');
}

/** 局部重绘：只动蒙版区域，其余保持原样。 */
export function inpaintInstruction(node: BoardNode): string {
  const note = String((node.data as { note?: string }).note ?? '').trim();
  return [
    '（局部重绘规范）',
    '只重绘蒙版标记的白色区域；蒙版之外的像素、构图、光线与风格都要原样保留。',
    '白色区域要自然融入周围画面，不要出现拼接痕迹。',
    note ? `补充要求：${note}；` : '',
  ].join('');
}

/** 业务节点 → 追加到提示词里的规范文本。 */
export function instructionFor(node: BoardNode): string | undefined {
  switch (node.type) {
    case 'character': return characterSheetInstruction(node);
    case 'storyboard': return storyboardGridInstruction(node);
    case 'expression': return expressionSheetInstruction(node);
    case 'variant': return variantSheetInstruction(node);
    case 'turnaround': return turnaroundInstruction(node);
    case 'coverage': return coverageInstruction(node);
    case 'continuity': return continuityInstruction(node);
    case 'redraw': return redrawInstruction(node);
    case 'inpaint': return inpaintInstruction(node);
    default: return undefined;
  }
}
