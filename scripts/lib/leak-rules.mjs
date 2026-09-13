/**
 * 泄露模式规则 —— **工作树扫描（release-check）与全历史扫描（scan-history）共用同一份**。
 *
 * 为什么要抽出来：这套规则曾经只覆盖 `lib/*` 与 `package.json`，而泄露出现在 `PUBLISHING.md` 里；
 * 修掉工作树之后，同样的内容又留在历史提交与旧标签里。规则分散在两处，就一定会有一处漏。
 * 这里是唯一的定义点：`findLeaks()` 是纯函数（输入文本，输出命中），两个扫描器都只调用它。
 */

/** [正则, 人话说明] —— 每一条都对应一次真实事故或高风险面 */
export const LEAK = [
  /*
   * 注意这里**不要求**结尾有斜杠：历史里的真实泄露就是「测试夹具里一行带真实用户名的 cwd」
   * 这种写法（裸路径、后面紧跟引号）。要求斜杠的写法会让它整条漏掉 —— 规则宁可宽一点，
   * 由下面的占位符白名单负责放行假路径。
   */
  [/\/home\/[A-Za-z0-9._-]+/, '开发机 /home/<user> 绝对路径'],
  [/\/Users\/[A-Za-z0-9._-]+/, '开发机 /Users/<user> 绝对路径'],
  [/C:\\\\Users\\\\/, '开发机 Windows 绝对路径'],
  [/\b(?:DESKTOP|LAPTOP|WIN)-[A-Z0-9]{6,}\b/, '开发机主机名'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '私钥内容'],
  [/\bnpm_[A-Za-z0-9]{36}\b/, 'npm token'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bsk-[A-Za-z0-9]{20,}\b/, 'API key（sk- 形态）'],
  [/\bAKIA[0-9A-Z]{12,}\b/, 'AWS access key'],
]

/**
 * 占位符不算泄露：文档与测试里到处都是 /home/u、/home/user 这种假路径。
 * 同样**不要求**结尾有斜杠 —— `/home/u'`、`/home/u"` 这类写法在代码里比比皆是。
 */
export const LEAK_ALLOW = [
  /\/home\/(?:u|user|you|username|me|test|example|someone|alice|bob)\b/,
  /\/Users\/(?:you|user|username|me|alice|bob)\b/,
]

/** 这些目录不是「仓库内容」：.git 是对象库本身，node_modules 与 .github 由平台维护 */
export const SKIP_DIRS = new Set(['.git', 'node_modules', '.github'])

/** 二进制/归档文件不做文本扫描 */
export const BINARY_FILE = /\.(?:tgz|png|jpg|jpeg|webp|gif|ico|zst|woff2?|wasm)$/i

/**
 * 在一段文本里找泄露。
 * @param {string} text 待扫描文本
 * @param {{ skipLine?: (line: string) => boolean }} [options] 额外放行规则
 * @returns {Array<{ line: number, what: string, text: string }>} 命中（行号从 1 开始）
 */
export function findLeaks (text, options = {}) {
  const hits = []
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (LEAK_ALLOW.some((allow) => allow.test(line))) continue
    if (options.skipLine !== undefined && options.skipLine(line)) continue
    for (const [pattern, what] of LEAK) {
      if (pattern.test(line)) hits.push({ line: index + 1, what, text: line.trim().slice(0, 80) })
    }
  }
  return hits
}
