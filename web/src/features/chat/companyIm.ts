/**
 * Company IM 投递信封解析。
 *
 * SDK 0.3.0 的 EntryView 只保留 role/blocks/messageId，结构化 sender 在投影层
 * 被丢弃；投递文本本身保留稳定信封，因此展示层只从文本开头还原发送者与话题。
 * 正文中的 `[Company IM ...]` 不会被当作信封。
 */
export type CompanyImEnvelope = {
  threadId: string;
  messageId: string;
  /** 解析失败时为空；展示层必须回退到未知成员，不能当成“你”。 */
  senderId: string | null;
  /** 已剥离机器信封与指令的正文。 */
  body: string;
  /** 信封标题无法完整解析时仍返回可渲染条目，sender 未知。 */
  degraded: boolean;
};

const BRACKET_WITH_SENDER =
  /^\[Company IM\s+([^\s/]+)\/([^\s\]]+)\s+from\s+([^\s\]]+)\]\s*$/;
const BRACKET_WITHOUT_SENDER =
  /^\[Company IM\s+([^\s/]+)\/([^\s\]]+)\]\s*$/;
const PLAIN_WITH_SENDER =
  /^Company IM\s+([^\s/]+)\/([^\s]+)\s+from\s+([^\s]+)\s*$/;
const PLAIN_WITHOUT_SENDER = /^Company IM\s+([^\s/]+)\/([^\s]+)\s*$/;
const PARTIAL_IDS = /^\[?Company IM\s+([^\s/]+)\/([^\s\]]+)/;
/** 投递器附带的机器指令；只剥离开头连续出现的那几行。 */
const MACHINE_INSTRUCTION =
  /^Read the original via company_im\.thread before replying\.?$/i;

/**
 * 只匹配文本开头：双信封、未来单信封与旧 domain-only 三种格式。
 * 普通文本返回 null；以 Company IM 开头但标题残缺时返回 `degraded` 条目。
 */
export function parseCompanyImMessage(
  text: string,
): CompanyImEnvelope | null {
  const source = text.replace(/^\uFEFF/, "").trimStart();
  if (!source) return null;

  const looksLikeEnvelope =
    /^\[Company IM\b/.test(source) ||
    /^Company IM\s+[^\s/]+\/[^\s]+/.test(source);
  if (!looksLikeEnvelope) return null;

  const lines = source.split(/\r?\n/);
  const firstLine = lines[0] ?? "";

  let threadId = "";
  let messageId = "";
  let senderId: string | null = null;
  let index = 1;

  const bracketedSender = firstLine.match(BRACKET_WITH_SENDER);
  const bracketed = bracketedSender
    ? null
    : firstLine.match(BRACKET_WITHOUT_SENDER);
  const plain = firstLine.match(PLAIN_WITH_SENDER);

  if (bracketedSender) {
    [, threadId, messageId, senderId] = bracketedSender;
  } else if (bracketed) {
    [, threadId, messageId] = bracketed;
    // 双信封：下一行（可隔空行）是带 sender 的同话题 domain 头。
    let nestedIndex = index;
    while (nestedIndex < lines.length && !lines[nestedIndex].trim())
      nestedIndex += 1;
    const nested = lines[nestedIndex]?.trim().match(PLAIN_WITH_SENDER);
    const repeated = lines[nestedIndex]?.trim().match(PLAIN_WITHOUT_SENDER);
    if (nested && nested[1] === threadId && nested[2] === messageId) {
      senderId = nested[3];
      index = nestedIndex + 1;
    } else if (
      repeated &&
      repeated[1] === threadId &&
      repeated[2] === messageId
    ) {
      // 旧版本可能省略 sender；不能把机器头留进正文。
      index = nestedIndex + 1;
    }
  } else if (plain) {
    [, threadId, messageId, senderId] = plain;
  } else {
    return degradedEnvelope(source);
  }

  index = skipPreamble(lines, index, threadId, messageId);
  return {
    threadId,
    messageId,
    senderId,
    body: bodyFromLines(lines.slice(index)),
    degraded: false,
  };
}

/** 解析失败时仍给出可渲染条目；绝不回退成普通用户气泡。 */
function degradedEnvelope(source: string): CompanyImEnvelope {
  const lines = source.split(/\r?\n/);
  const partial = (lines[0] ?? "").match(PARTIAL_IDS);
  let index = 1;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line || MACHINE_INSTRUCTION.test(line) || /^\[?Company IM\b/.test(line)) {
      index += 1;
      continue;
    }
    break;
  }
  return {
    threadId: partial?.[1] ?? "",
    messageId: partial?.[2] ?? "",
    senderId: null,
    body: bodyFromLines(lines.slice(index)),
    degraded: true,
  };
}

function skipPreamble(
  lines: string[],
  start: number,
  threadId: string,
  messageId: string,
): number {
  let index = start;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (!line || MACHINE_INSTRUCTION.test(line)) {
      index += 1;
      continue;
    }
    // 双信封可能重复同一 domain 头；只剥离开头且身份完全一致的行。
    const repeated =
      line.match(PLAIN_WITH_SENDER) ?? line.match(PLAIN_WITHOUT_SENDER);
    if (repeated?.[1] === threadId && repeated[2] === messageId) {
      index += 1;
      continue;
    }
    break;
  }
  return index;
}

/** 去掉正文前后的空行；保留首行缩进与正文内部代码块。 */
function bodyFromLines(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/^(?:[ \t]*\r?\n)+/, "")
    .trimEnd();
}
