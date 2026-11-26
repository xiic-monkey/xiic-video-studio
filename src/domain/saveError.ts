/**
 * 保存失败时的文案。
 *
 * 后端返回的是错误码（PRODUCTION_REVISION_CONFLICT 之类），
 * 直接甩到界面上没人知道该怎么办，这里翻成一句能照着做的话。
 */
export function describeSaveError(message: string, subject: string, advice: string): string {
  if (message.includes('REVISION_CONFLICT')) return `${subject}修订冲突，本次改动没有落库。${advice}`;
  if (message.includes('VALIDATION_FAILED')) return `${subject}内容校验没通过。${advice}`;
  return message;
}
