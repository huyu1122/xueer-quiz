/**
 * 浏览器加载顺序集成测试
 *
 * 目的：单元测试各自独立加载模块，无法发现**脚本加载顺序**问题。
 * 本测试严格按 index.html 中的 <script> 顺序加载全部脚本，
 * 模拟真实浏览器的初始化过程，验证：
 *   1. 所有全局对象正确暴露（QuizMerge / Render / Api / Store）
 *   2. render.js 早于 katex.min.js 加载时，公式渲染仍可用（惰性检测）
 *   3. 应用能完成初始化并渲染出页面
 *   4. 题库、合并、复习、知识点等能力在真实加载顺序下都可用
 *
 * 运行： node test/loadorder.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

/* ============================================================
   从 index.html 解析真实的脚本加载顺序
   ============================================================ */
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"><\/script>/g)].map(m => m[1]);

console.log("=".repeat(64));
console.log("浏览器加载顺序集成测试");
console.log("=".repeat(64));
console.log("\nindex.html 中的脚本顺序：");
scriptSrcs.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

/* 同时解析样式表，确认 KaTeX CSS 已引入 */
const cssHrefs = [...html.matchAll(/<link\s+rel="stylesheet"\s+href="([^"]+)"/g)].map(m => m[1]);
console.log("\n样式表：");
cssHrefs.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); }
};

/* ============================================================
   构造浏览器环境（含 DOM 桩）
   ============================================================ */
function makeEl(tag) {
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    dataset: {}, style: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) { const on = f === undefined ? !this._s.has(c) : !!f; on ? this._s.add(c) : this._s.delete(c); return on; },
      contains(c) { return this._s.has(c); }
    },
    textContent: "", _html: "",
    onclick: null, onchange: null, oninput: null, onkeydown: null, onsubmit: null,
    disabled: false, value: "", files: [],
    closest() { return null; },
    remove() {}, appendChild() {}, removeAttribute() {}, setAttribute() {},
    getAttribute() { return null; }, focus() {},
    click() { if (typeof this.onclick === "function") this.onclick({ target: this }); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; }
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el._html = String(v); }
  });
  return el;
}

const navButtons = {};
["home", "review", "practice", "exam", "wrong", "favorite", "notes", "stats", "knowledge", "settings"]
  .forEach(v => { const b = makeEl("button"); b.dataset.nav = v; navButtons[v] = b; });

const subjectBtn = makeEl("button");
subjectBtn.dataset.startSubject = "高等数学";

const elCache = new Map();
const appEl = makeEl("main");
elCache.set("app", appEl);

const selCache = new Map();
function queryOne(sel) {
  if (sel.startsWith("#")) return document.getElementById(sel.slice(1));
  if (!selCache.has(sel)) selCache.set(sel, makeEl("div"));
  return selCache.get(sel);
}

const document = {
  documentElement: { dataset: {} },
  body: { dataset: {} },
  /**
   * 真实浏览器在 <!DOCTYPE html> 下为 "CSS1Compat"（标准模式）。
   * KaTeX 会据此判断是否 quirks mode，缺失该属性会误报警告。
   * 这里显式声明，使测试环境与真实浏览器一致。
   */
  compatMode: "CSS1Compat",
  getElementById(id) {
    if (!elCache.has(id)) elCache.set(id, makeEl("div"));
    return elCache.get(id);
  },
  querySelector(sel) { return sel === "#app" ? appEl : queryOne(sel); },
  querySelectorAll(sel) {
    if (sel === "[data-nav]") return Object.values(navButtons);
    if (sel === "[data-start-subject]") return [subjectBtn];
    return [];
  },
  createElement(t) { return makeEl(t); },
  addEventListener() {}, removeEventListener() {}
};

const mem = {};
const localStorage = {
  getItem: k => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: k => { delete mem[k]; }
};

const sandbox = {
  document, localStorage, console,
  setTimeout, clearTimeout, setInterval, clearInterval, Promise,
  Blob: class {}, URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  URLSearchParams, FileReader: class { readAsText() {} },
  confirm: () => true, alert: () => {},
  navigator: { userAgent: "node" },
  scrollTo() {}, addEventListener() {},
  fetch: () => Promise.reject(new Error("offline")),
  location: { href: "http://localhost/", origin: "http://localhost" }
};
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ============================================================
   按 index.html 的真实顺序加载
   ============================================================ */
console.log("\n按顺序加载脚本...");
const loaded = [];
for (const src of scriptSrcs) {
  const file = path.join(ROOT, src);
  if (!fs.existsSync(file)) {
    ok(`脚本存在：${src}`, false, "文件不存在");
    continue;
  }
  const code = fs.readFileSync(file, "utf8");
  try {
    vm.runInContext(code, sandbox, { filename: src });
    loaded.push(src);
    console.log(`  ✓ ${src}`);
  } catch (e) {
    ok(`加载 ${src}`, false, e.message);
    console.log(`  ✗ ${src}: ${e.message}`);
  }
}
ok("全部脚本加载成功", loaded.length === scriptSrcs.length,
  `${loaded.length}/${scriptSrcs.length}`);

/* ============================================================
   验证全局对象暴露
   ============================================================ */
console.log("\n验证全局对象：");
[
  ["QUESTION_BANK", "题库"],
  ["QuizMerge", "合并与复习算法"],
  ["Render", "内容渲染"],
  ["Api", "API 客户端"],
  ["Store", "数据层"]
].forEach(([name, desc]) => {
  const obj = sandbox.window[name];
  const present = obj !== undefined && obj !== null;
  ok(`全局 ${name} 已暴露（${desc}）`, present);
  console.log(`  ${present ? "✓" : "✗"} ${name} — ${desc}`);
});

/* ============================================================
   关键：render.js 早于 katex.min.js 加载，公式仍须可用
   ============================================================ */
console.log("\n验证公式渲染（render.js 先于 katex.min.js 加载）：");
const R = sandbox.window.Render;
if (R) {
  ok("Render 是惰性检测 KaTeX（加载顺序无关）", R.hasKatex() === true,
    `hasKatex() = ${R.hasKatex()}`);

  const out = R.rich("极限 $\\lim\\limits_{x \\to 0} \\dfrac{\\sin x}{x}$ 的值");
  ok("公式被渲染为 KaTeX 结构", out.includes("katex"), out.slice(0, 90));
  ok("公式外文字保留", out.includes("极限") && out.includes("的值"));
  ok("含 MathML 输出", out.includes("katex-mathml") || out.includes("<math"));
  console.log(`  渲染结果长度：${out.length} 字符`);
}

/* KaTeX CSS 必须已引入，否则公式会错乱 */
ok("KaTeX 样式表已引入", cssHrefs.some(h => /katex.*\.css/i.test(h)),
  cssHrefs.join(", "));

/* index.html 必须有 doctype，否则浏览器进入 quirks mode 导致公式排版错乱 */
ok("index.html 声明了 <!DOCTYPE html>（避免 quirks mode）",
  /^\s*<!DOCTYPE\s+html>/i.test(html), "缺少 doctype，KaTeX 在 quirks mode 下排版异常");

/* ============================================================
   验证应用完成初始化
   ============================================================ */
console.log("\n验证应用初始化：");
const appHtml = appEl.innerHTML || "";
ok("首页已渲染", appHtml.length > 0, `${appHtml.length} 字符`);
ok("首页含欢迎语", appHtml.includes("欢迎回来"));
ok("首页含复习入口", appHtml.includes("复习") || appHtml.includes("review"));

/* ============================================================
   验证各能力在真实加载顺序下可用
   ============================================================ */
console.log("\n验证核心能力：");
const S = sandbox.window.Store;
const M = sandbox.window.QuizMerge;
const BANK = sandbox.window.QUESTION_BANK;

ok("题库非空", Array.isArray(BANK) && BANK.length > 0, `${BANK ? BANK.length : 0} 题`);
ok("题库含知识点标签", BANK.every(q => Array.isArray(q.knowledge) && q.knowledge.length));
ok("题库含 LaTeX 公式", BANK.some(q => /\$[^\s$]/.test(q.stem)));

/* 合并能力 */
if (M) {
  const a = M.emptyProgress(); a.records["x"] = { attempts: 1, correct: 1, wrong: 0, lastAt: 1 };
  const b = M.emptyProgress(); b.records["y"] = { attempts: 1, correct: 0, wrong: 1, lastAt: 2 };
  const m = M.mergeProgress(a, b);
  ok("合并保留双方记录", !!m.records.x && !!m.records.y);
  ok("合并满足交换律",
    JSON.stringify(M.mergeProgress(a, b)) === JSON.stringify(M.mergeProgress(b, a)));
}

/* 间隔重复能力 */
if (M) {
  const t0 = 1700000000000;
  const r1 = M.scheduleReview(undefined, true, t0);
  const r2 = M.scheduleReview(r1, true, t0);
  ok("间隔重复：答对后间隔递增", r2.dueAt > r1.dueAt);
}

/* 数据层能力 */
if (S) {
  ok("Store 暴露 mergeProgress", typeof S.mergeProgress === "function");
  ok("Store 暴露 scheduleReview", typeof S.scheduleReview === "function");
  ok("Store 暴露 dueForReview", typeof S.dueForReview === "function");
  ok("Store 暴露 dueList", typeof S.dueList === "function");

  const q = BANK[0];
  S.recordAnswer(q.id, true);
  ok("答题后生成复习计划", !!S.getReview(q.id));
  ok("答题后记录已保存", !!S.getRecord(q.id));
}

/* 视图切换：确认新增视图都能渲染 */
console.log("\n验证视图渲染（真实加载顺序）：");
["review", "knowledge", "notes", "stats", "settings"].forEach(v => {
  try {
    navButtons[v].click();
    const html2 = appEl.innerHTML || "";
    const okView = html2.length > 100;
    ok(`视图 ${v} 渲染`, okView, `${html2.length} 字符`);
    console.log(`  ${okView ? "✓" : "✗"} ${v} — ${html2.length} 字符`);
  } catch (e) {
    ok(`视图 ${v} 渲染`, false, e.message);
  }
});

/* 笔记与目标能力在真实加载顺序下可用 */
console.log("\n验证笔记与每日目标能力：");
if (S) {
  ok("Store 暴露 saveNote", typeof S.saveNote === "function");
  ok("Store 暴露 getNote", typeof S.getNote === "function");
  ok("Store 暴露 noteList", typeof S.noteList === "function");
  ok("Store 暴露 setGoals", typeof S.setGoals === "function");
  ok("Store 暴露 goalProgress", typeof S.goalProgress === "function");
  ok("Store 暴露 goalHistory", typeof S.goalHistory === "function");

  const q = BANK[0];
  S.saveNote(q.id, "加载顺序测试笔记");
  ok("笔记可保存并读回", !!S.getNote(q.id));
  ok("noteList 包含该笔记", S.noteList().includes(q.id));

  S.setGoals({ dailyQuestions: 30 });
  const gp = S.goalProgress();
  ok("目标设置生效", gp.target === 30, `实际 ${gp.target}`);
  ok("目标进度结构完整",
    typeof gp.done === "number" && typeof gp.percent === "number" && typeof gp.met === "boolean");
  ok("目标历史返回 14 天", S.goalHistory(14).length === 14);
}

/* 首页应含目标卡片 */
navButtons.home.click();
const homeHtml = appEl.innerHTML || "";
ok("首页渲染目标卡片", homeHtml.includes("goal-card"), `${homeHtml.length} 字符`);
ok("首页含每日目标文案", /目标/.test(homeHtml));

/* ============================================================
   报告
   ============================================================ */
console.log("\n" + "=".repeat(64));
console.log(`通过：${pass}    失败：${fail}`);
if (problems.length) {
  console.log("\n✗ 问题：");
  problems.forEach(p => console.log("  - " + p));
} else {
  console.log("\n✓ 按真实浏览器加载顺序，全部模块正常初始化，公式渲染与各视图均可用。");
}
console.log("=".repeat(64));
process.exit(fail ? 1 : 0);
