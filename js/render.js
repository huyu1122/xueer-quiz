/**
 * 学而刷题 —— 内容渲染模块
 *
 * 职责：把题目文本安全地渲染为 HTML，支持内嵌 LaTeX 公式。
 *
 * 安全设计（重要）：
 *  - 非公式部分一律 HTML 转义，杜绝 XSS
 *  - 公式交给 KaTeX 渲染，且显式关闭 trust（禁止 \href、\htmlClass 等危险指令）
 *  - KaTeX 不可用时**优雅降级**为转义后的原文，不影响做题
 *
 * 公式定界符：
 *  - $...$    行内公式
 *  - $$...$$  块级公式
 *  - \(...\)  行内公式（兼容写法）
 *  - \[...\]  块级公式（兼容写法）
 */
const Render = (() => {
  "use strict";

  const hasKatex = () => typeof window !== "undefined"
    && window.katex && typeof window.katex.renderToString === "function";

  /** HTML 转义 */
  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /** 用 KaTeX 渲染一段公式，失败时降级为转义原文 */
  function renderMath(tex, displayMode) {
    if (!hasKatex()) return esc(displayMode ? `$$${tex}$$` : `$${tex}$`);
    try {
      return window.katex.renderToString(tex, {
        displayMode: !!displayMode,
        throwOnError: false,      // 语法错误时渲染为红色文本而非抛异常
        errorColor: "#dc2626",
        trust: false,             // 关键安全项：禁用 \href / \htmlClass / \includegraphics 等
        strict: false,
        output: "htmlAndMathml"   // 同时输出 MathML，兼顾可访问性与复制
      });
    } catch {
      return esc(displayMode ? `$$${tex}$$` : `$${tex}$`);
    }
  }

  /**
   * 把可能含公式的文本渲染为安全 HTML。
   * @param {string} text
   * @returns {string} HTML
   */
  function rich(text) {
    const src = String(text ?? "");
    if (!src) return "";

    // 无公式时走纯转义快路径
    if (!/\$|\\\(|\\\[/.test(src)) return esc(src);

    let out = "";
    let i = 0;

    while (i < src.length) {
      // 块级 $$...$$
      if (src.startsWith("$$", i)) {
        const end = src.indexOf("$$", i + 2);
        if (end > i) {
          out += renderMath(src.slice(i + 2, end).trim(), true);
          i = end + 2;
          continue;
        }
      }
      // 块级 \[...\]
      if (src.startsWith("\\[", i)) {
        const end = src.indexOf("\\]", i + 2);
        if (end > i) {
          out += renderMath(src.slice(i + 2, end).trim(), true);
          i = end + 2;
          continue;
        }
      }
      // 行内 \(...\)
      if (src.startsWith("\\(", i)) {
        const end = src.indexOf("\\)", i + 2);
        if (end > i) {
          out += renderMath(src.slice(i + 2, end).trim(), false);
          i = end + 2;
          continue;
        }
      }
      // 行内 $...$
      /*
       * 判定规则（曾踩坑）：
       *   早期用「$ 后不能是数字或空格」来避免把「价格 $5」误判为公式，
       *   但这把 $0$、$1$、$e^x$ 这类**合法的纯数字/短公式**也拦掉了 ——
       *   数学题选项恰恰大量使用这种写法，导致选项显示原始 $...$ 文本。
       *
       * 现改为：只要能找到配对的下一个 $ 且内部非空，就按公式处理。
       * 「价格 $5」这种自然文本没有配对的第二个 $，仍不会被误判。
       * 代价是「$5 和 $6」这种含两个独立美元符号的文本会被误判，
       * 但在本系统中内容都是题库数据，出现裸美元符号的概率极低。
       */
      if (src[i] === "$") {
        const end = src.indexOf("$", i + 1);
        if (end > i + 1) {   // 内部至少 1 个字符：$...$ 而非 $$（块级已单独处理）
          out += renderMath(src.slice(i + 1, end).trim(), false);
          i = end + 1;
          continue;
        }
      }

      // 普通字符：累积到下一个公式起点，整段转义
      let next = i + 1;
      while (next < src.length
        && src[next] !== "$"
        && !src.startsWith("\\(", next)
        && !src.startsWith("\\[", next)) next++;
      out += esc(src.slice(i, next));
      i = next;
    }

    return out;
  }

  /**
   * 判断一段文本是否含**会被渲染**的公式。
   * 规则必须与 rich() 保持一致：
   *   - $...$ 成对且内部非空即为公式（$0$ 也算）
   *   - 单独一个 $（无配对）不算，因此「价格 $5」不会误判
   */
  function hasMath(text) {
    const src = String(text ?? "");
    if (/\\\(|\\\[/.test(src)) return true;
    if (/\$\$/.test(src)) return true;
    // 成对的 $...$，内部至少 1 个非 $ 字符
    return /\$[^$][^$]*\$/.test(src);
  }

  return { esc, rich, renderMath, hasMath, hasKatex };
})();

window.Render = Render;
