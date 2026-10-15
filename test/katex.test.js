/**
 * KaTeX 集成验证（临时脚本）
 * 用真实的 KaTeX 库 + render.js，验证公式渲染与安全设置确实生效。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

/* 构造浏览器环境并加载真实 KaTeX */
const sandbox = { console, setTimeout, clearTimeout };
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.document = {
  createElement: () => ({}),
  addEventListener() {},
  // 标准模式：与真实浏览器 <!DOCTYPE html> 一致，避免 KaTeX 误报 quirks mode
  compatMode: "CSS1Compat"
};
vm.createContext(sandbox);

/* KaTeX 的 UMD 需要 module 或 global；这里让它挂到全局 */
vm.runInContext(fs.readFileSync(path.join(ROOT, "vendor", "katex", "katex.min.js"), "utf8"), sandbox, { filename: "katex.min.js" });
vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "render.js"), "utf8"), sandbox, { filename: "render.js" });

const R = sandbox.window.Render;

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); }
};

console.log("=".repeat(64));
console.log("KaTeX 公式渲染验证");
console.log("=".repeat(64));
console.log(`KaTeX 可用：${R.hasKatex()}`);

/* 1. 基本渲染 */
{
  const out = R.rich("极限 $\\lim\\limits_{x \\to 0} \\dfrac{\\sin x}{x}$ 的值");
  ok("行内公式被渲染为 KaTeX 结构", out.includes("katex"), out.slice(0, 100));
  ok("公式外文字保留", out.includes("极限") && out.includes("的值"));
  ok("渲染出 MathML（可访问性）", out.includes("<math") || out.includes("katex-mathml"),
    "未找到 MathML 输出");
}

/* 2. 块级公式 */
{
  const out = R.rich("$$\\int_{0}^{1} x^{2}\\,dx = \\frac{1}{3}$$");
  ok("块级公式渲染", out.includes("katex-display"), out.slice(0, 80));
}

/* 3. 安全：trust=false 应阻止 \href */
{
  const out = R.rich("$\\href{javascript:alert(1)}{点我}$");
  const hasJsLink = /href\s*=\s*["']?javascript:/i.test(out);
  ok("禁止 \\href 生成 javascript: 链接", !hasJsLink, hasJsLink ? out.slice(0, 200) : "");
}

/* 4. 安全：\htmlClass / \htmlData 等注入指令
   注意判定标准：应检查是否**生成了该 class 属性**，
   而非文本中是否出现 "evil"（原 TeX 源码会出现在 KaTeX 的
   annotation 元素里，那是惰性文本，不具可执行性）。 */
{
  const out = R.rich("$\\htmlClass{evil}{x}$");
  const injected = /class\s*=\s*"[^"]*\bevil\b/.test(out);
  ok("禁止 \\htmlClass 注入类名", !injected,
    injected ? out.slice(0, 160) : "");
  // 确认该指令确实被当作错误处理（渲染为错误色文本）
  ok("\\htmlClass 被识别为不受信指令", out.includes("dc2626") || out.includes("katex-error"),
    "未看到错误标记");
}

/* 4b. 安全：\htmlData 同样应被拒绝 */
{
  const out = R.rich("$\\htmlData{foo=bar}{x}$");
  const injected = /data-foo\s*=/i.test(out);
  ok("禁止 \\htmlData 注入 data 属性", !injected, injected ? out.slice(0, 160) : "");
}

/* 4c. 安全：\includegraphics 不应产生真实 img 标签 */
{
  const out = R.rich("$\\includegraphics{http://evil.test/x.png}$");
  ok("禁止 \\includegraphics 生成 img 标签", !/<img\b/i.test(out),
    /<img\b/i.test(out) ? out.slice(0, 160) : "");
}

/* 5. 语法错误不崩溃（throwOnError:false） */
{
  let threw = false;
  let out = "";
  try { out = R.rich("$\\frac{1}{$"); } catch { threw = true; }
  ok("公式语法错误不抛异常", !threw);
  ok("语法错误仍产出内容", out.length > 0);
}

/* 6. 混合内容与转义 */
{
  const out = R.rich("<b>粗体</b> 与公式 $x^2$");
  ok("公式外的 HTML 被转义", !/<b>/.test(out) && out.includes("&lt;b&gt;"), out.slice(0, 100));
  ok("混合内容中公式仍渲染", out.includes("katex"));
}

/* 7. 题库真实题目渲染 */
{
  const qb = { window: {} };
  vm.createContext(qb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "questions.js"), "utf8"), qb);
  const BANK = qb.window.QUESTION_BANK;

  let rendered = 0, failed = [];
  BANK.forEach(q => {
    try {
      const out = R.rich(q.stem);
      if (!out || out.includes("katex-error")) failed.push(q.id);
      else rendered++;
    } catch (e) {
      failed.push(q.id + ":" + e.message);
    }
  });
  ok(`全部 ${BANK.length} 道题题干均可渲染`, failed.length === 0,
    failed.length ? `失败 ${failed.length} 道：${failed.slice(0, 5).join(", ")}` : "");

  // 统计有多少题含公式
  const withMath = BANK.filter(q => R.hasMath(q.stem)).length;
  console.log(`  含公式的题干：${withMath} / ${BANK.length} 道`);
}

/* 8. 抽样展示渲染结果的纯文本 */
{
  const out = R.rich("$\\lim\\limits_{x \\to 0} \\dfrac{\\sin x}{x}$");
  const text = out.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  console.log(`\n  渲染抽样（去标签）：${text.slice(0, 60)}`);
}

console.log("\n" + "=".repeat(64));
console.log(`通过：${pass}    失败：${fail}`);
if (problems.length) {
  console.log("\n✗ 问题：");
  problems.forEach(p => console.log("  - " + p));
} else {
  console.log("\n✓ KaTeX 集成正常：公式渲染、MathML 输出、trust 安全设置均符合预期。");
}
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
