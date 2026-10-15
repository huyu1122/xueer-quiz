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
      // 行内 $...$（要求 $ 后不是数字或空格，避免误伤 "价格$5" 这类文本）
      if (src[i] === "$" && !/[\s\d]/.test(src[i + 1] || "")) {
        const end = src.indexOf("$", i + 1);
        if (end > i) {
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
   * 规则必须与 rich() 保持一致：$ 后紧跟数字或空格的不算公式
   * （避免把「价格 $5」这类文本误判为公式）。
   */
  function hasMath(text) {
    const src = String(text ?? "");
    if (/\\\(|\\\[/.test(src)) return true;
    if (/\$\$/.test(src)) return true;
    // 行内 $...$：$ 后不能是空白或数字
    return /\$[^\s\d$]/.test(src);
  }

  return { esc, rich, renderMath, hasMath, hasKatex };
})();

window.Render = Render;
