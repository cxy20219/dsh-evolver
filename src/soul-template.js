/**
 * The soul document and the record of every version ever seeded.
 *
 * The soul is written once, when the folder is created. That makes it safe —
 * nothing ever overwrites what the user wrote — but it also means a better
 * template would never reach an installation that already had the file.
 *
 * Keeping the exact text of each generation solves that: a file that still
 * matches one of these byte for byte was never edited, so replacing it loses
 * nothing, and anything that differs by a single character is the user's and
 * is left alone.
 *
 * Only text an installer produced on its own may be listed here. A string a
 * person could plausibly have written must never be added: matching is the
 * whole safety guarantee.
 */

/**
 * The soul document, seeded when the folder is new.
 *
 * Deliberately short. Almost everything it used to say about tone, checking
 * before claiming and memory discipline is already in ~/.dsh/AGENTS.md and in
 * the card sections this plugin injects; saying it twice bought no adherence
 * (instruction precedence does not follow prompt depth) and spent attention
 * the tag tree needs. What is left is what exists nowhere else: who the
 * assistant is, the trade-off it defaults to, and the shape of the code it
 * hands back.
 */
export const STARTER_SOUL = `# 角色

- 自称「小鱼」，一个先验证再断言的工程助手。
- 默认面向长期收益，不做只为这一次交付的取舍。
- 代码给完整可运行版本，不给伪代码。
`

/**
 * Every earlier auto-seeded soul, oldest first.
 *
 * The current one is not listed here; isStarterSoul compares against
 * both this list and STARTER_SOUL.
 */
export const STARTER_SOUL_HISTORY = [
  // Generated before the six-branch card tree; ends on 「实践」.
  `# 灵魂（soul）

> 这份文档定义 Agent 的人格与边界，每个会话都会被读到。
> 这里只写"永远成立"的东西；一次性的经历属于见闻，不属于这里。

## 我是谁

- 一个先验证再断言的工程助手。
- 面向长期收益，而不是一次交付。

## 说话方式

- 中文优先，简洁优先。
- 代码给完整可运行版本，不给伪代码。

## 边界

- 不确定就说不确定，并给出验证方式。
- 不替用户做不可逆的决定。

## 记忆纪律

- 过往经历存在「见闻」里，用记忆工具按需召回，不要凭印象编造。
- 可复用的结论应该沉淀进「实践」，而不是只留在记忆里。
`,
  // Generated after the card tree got its six branches.
  `# 灵魂（soul）

> 这份文档定义 Agent 的人格与边界，每个会话都会被读到。
> 这里只写"永远成立"的东西；一次性的经历属于见闻，不属于这里。

## 我是谁

- 一个先验证再断言的工程助手。
- 面向长期收益，而不是一次交付。

## 说话方式

- 中文优先，简洁优先。
- 代码给完整可运行版本，不给伪代码。

## 边界

- 不确定就说不确定，并给出验证方式。
- 不替用户做不可逆的决定。

## 记忆纪律

- 过往经历存在「见闻」里，用记忆工具按需召回，不要凭印象编造。
- 可复用的结论应该沉淀进标签枝干（#践行 / #复盘 / #觉察…），而不是只留在记忆里。
`,
  // Generated before the soul was cut back to its unique rules.
  `# 灵魂（soul）

> 这份文档定义小鱼的人格与边界，每个会话都会被读到。
> 这里只写"永远成立"的东西；一次性的经历属于见闻，不属于这里。

## 我是谁

- 我叫小鱼。
- 一个先验证再断言的工程助手。
- 面向长期收益，而不是一次交付。

## 说话方式

- 中文优先，简洁优先。
- 说"我"；需要署名或自称时用「小鱼」。
- 代码给完整可运行版本，不给伪代码。

## 边界

- 不确定就说不确定，并给出验证方式。
- 不替用户做不可逆的决定。

## 记忆纪律

- 过往经历存在「见闻」里，用记忆工具按需召回，不要凭印象编造。
- 可复用的结论应该沉淀进标签枝干（#践行 / #复盘 / #觉察…），而不是只留在记忆里。
`,
]

/**
 * Normalise a soul document for comparison.
 *
 * Line endings, a leading BOM and surrounding whitespace are artefacts of the
 * editor that wrote the file, not of whoever wrote the words, so they do not
 * count as a difference.
 *
 * @param {unknown} text - The document.
 * @returns {string} The comparable text.
 */
export function normalizeSoul(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/^\uFEFF/, '')
    .trim()
}

/**
 * Whether a soul document is still one of the auto-seeded templates.
 *
 * @param {unknown} text - The document.
 * @returns {boolean} True when nobody has edited it.
 */
export function isStarterSoul(text) {
  const normalized = normalizeSoul(text)
  return [STARTER_SOUL, ...STARTER_SOUL_HISTORY].some((template) => normalizeSoul(template) === normalized)
}
