/**
 * Composer 字数上限：与 `@peri-code/sdk` 的内部 `MAX_SEND_TEXT_LENGTH` 同源
 * （SDK 0.3.0 `dist/index.js` 的 32_768，未导出该常量）。
 */
export const MAX_COMPOSER_CHARS = 32_768;
/** 达到该比例后开始显示计数，避免平时占用状态栏空间。 */
export const COMPOSER_NEAR_LIMIT_RATIO = 0.8;

export interface ComposerLimitState {
  length: number;
  max: number;
  remaining: number;
  /** 是否达到展示阈值（>= 80%）。 */
  nearLimit: boolean;
  /** 超过发送上限：发送必须被阻断，但草稿仍可编辑。 */
  overLimit: boolean;
  showCount: boolean;
}

export function composerLimitState(text: string): ComposerLimitState {
  const length = text.length;
  const remaining = MAX_COMPOSER_CHARS - length;
  const nearLimit = length >= MAX_COMPOSER_CHARS * COMPOSER_NEAR_LIMIT_RATIO;
  const overLimit = length > MAX_COMPOSER_CHARS;
  return { length, max: MAX_COMPOSER_CHARS, remaining, nearLimit, overLimit, showCount: nearLimit };
}

/** 可见提示：接近上限显示计数，超限显示可执行的删减要求。 */
export function composerLimitMessage(state: ComposerLimitState): string | null {
  if (state.overLimit) {
    return `已超出 ${state.length - state.max} 字，请删减到 ${state.max} 字以内。`;
  }
  if (state.nearLimit) return `已输入 ${state.length} / ${state.max} 字`;
  return null;
}

/** 屏幕阅读器只在跨过阈值时播报；文案不随逐字长度变化，避免每次按键重复播报。 */
export function composerLimitAnnouncement(state: ComposerLimitState): string {
  if (state.overLimit) return '输入已超出上限，发送已禁用。';
  if (state.nearLimit) return '输入接近上限，发送仍可用。';
  return '';
}
