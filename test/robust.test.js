/**
 * 健壮性回归测试：异常本地数据不应导致「没有题目」
 *
 * 背景（真实故障）：
 *   用户报告「没有题目」。经真实浏览器诊断，发现当 localStorage 中
 *   存有**类型异常的字段**（如 records 是数组、wrong 是 null）时，
 *   旧版 load() 的浅合并会让非法值覆盖默认空对象，
 *   随后 Object.keys() 抛 TypeError，首页渲染中断 ——
 *   页面只剩 18 个字符，题目全部消失。
 *
 * 本测试固化修复后的行为：任何异常数据都必须正常降级。
 *
 * 运行： node test/robust.test.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); }
};

/* ============================================================
   构造浏览器环境
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
    disabled: false, value: "", files: [], id: "",
    closest() { return null; },
    remove() {}, appendChild() {}, insertBefore() {},
    removeAttribute() {}, setAttribute() {}, getAttribute() { return null; },
    focus() {}, click() { if (typeof this.onclick === "function") this.onclick({ target: this }); },
    querySelector() { return makeEl(); }, querySelectorAll() { return []; }
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el._html = String(v); }
  });
  return el;
}

/** 用给定的 localStorage 初始内容跑一次应用初始化 */
function bootWithStorage(initial) {
  const navButtons = {};
  ["home", "review", "practice", "exam", "wrong", "favorite", "notes", "stats", "knowledge", "settings"]
    .forEach(v => { const b = makeEl("button"); b.dataset.nav = v; navButtons[v] = b; });

  const subjectBtn = makeEl("button");
  subjectBtn.dataset.startSubject = "高等数学";

  const elCache = new Map();
  const appEl = makeEl("main");
  elCache.set("app", appEl);
  elCache.set("homeBtn", makeEl("button"));

  const selCache = new Map();
  const queryOne = (sel) => {
    if (sel.startsWith("#")) {
      const id = sel.slice(1);
      if (!elCache.has(id)) elCache.set(id, makeEl("div"));
      return elCache.get(id);
    }
    if (!selCache.has(sel)) selCache.set(sel, makeEl("div"));
    return selCache.get(sel);
  };

  const document = {
    documentElement: { dataset: {} },
    body: { dataset: {}, appendChild() {} },
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

  const mem = { ...initial };
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
    location: { href: "http://localhost/", reload() {} }
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  /* 按 index.html 的真实顺序加载 */
  const errs = [];
  for (const f of ["questions.js", "merge.js", "render.js", "api.js", "store.js", "app.js"]) {
    const code = fs.readFileSync(path.join(ROOT, "js", f), "utf8");
    try {
      vm.runInContext(code, sandbox, { filename: f });
    } catch (e) {
      errs.push(`${f}: ${e.message}`);
    }
  }

  return {
    sandbox, appEl, navButtons, subjectBtn, document, errs,
    Store: sandbox.window.Store,
    BANK: sandbox.window.QUESTION_BANK
  };
}

/* ============================================================
   一、Store.load 的类型校验
   ============================================================ */
console.log("=".repeat(66));
console.log("健壮性回归测试：异常本地数据");
console.log("=".repeat(66));
console.log("\n【一】Store 载入异常数据的容错");

const KEY = "xueer-quiz-v1";

/** 每个用例：坏数据 → 期望字段被修正为合法类型 */
const CASES = [
  { name: "records 是数组", bad: { records: [] }, field: "records", kind: "object" },
  { name: "records 是字符串", bad: { records: "abc" }, field: "records", kind: "object" },
  { name: "wrong 是 null", bad: { wrong: null }, field: "wrong", kind: "object" },
  { name: "wrong 是数字", bad: { wrong: 123 }, field: "wrong", kind: "object" },
  { name: "favorites 是数组", bad: { favorites: [] }, field: "favorites", kind: "object" },
  { name: "exams 是对象", bad: { exams: {} }, field: "exams", kind: "array" },
  { name: "exams 是 null", bad: { exams: null }, field: "exams", kind: "array" },
  { name: "daily 是数组", bad: { daily: [] }, field: "daily", kind: "object" },
  { name: "daily 是布尔", bad: { daily: true }, field: "daily", kind: "object" },
  { name: "review 是字符串", bad: { review: "x" }, field: "review", kind: "object" },
  { name: "notes 是 null", bad: { notes: null }, field: "notes", kind: "object" },
  { name: "notes 是数组", bad: { notes: [] }, field: "notes", kind: "object" },
  { name: "goals 是数组", bad: { goals: [] }, field: "goals", kind: "object" },
  { name: "streak 是 null", bad: { streak: null }, field: "streak", kind: "object" },
  { name: "settings 是数组", bad: { settings: [] }, field: "settings", kind: "object" }
];

CASES.forEach(c => {
  const inst = bootWithStorage({ [KEY]: JSON.stringify(c.bad) });
  const d = inst.Store.data;
  const v = d[c.field];
  const valid = c.kind === "array" ? Array.isArray(v) : (v !== null && typeof v === "object" && !Array.isArray(v));
  ok(`修正「${c.name}」`, valid,
    `实际类型 ${Array.isArray(v) ? "array" : (v === null ? "null" : typeof v)}`);
});

/* 顶层不是对象 */
[
  { name: "顶层是 null", raw: "null" },
  { name: "顶层是数组", raw: "[1,2,3]" },
  { name: "顶层是数字", raw: "42" },
  { name: "顶层是字符串", raw: '"hello"' },
  { name: "损坏的 JSON", raw: "{not json" },
  { name: "空字符串", raw: "" }
].forEach(c => {
  const inst = bootWithStorage({ [KEY]: c.raw });
  const d = inst.Store.data;
  const allOk = ["records", "wrong", "favorites", "daily", "review", "notes"]
    .every(f => d[f] && typeof d[f] === "object" && !Array.isArray(d[f]))
    && Array.isArray(d.exams);
  ok(`顶层异常「${c.name}」时完全重置`, allOk);
});

/* ============================================================
   二、应用整体初始化不崩溃
   ============================================================ */
console.log("\n【二】异常数据下应用仍能初始化");

CASES.slice(0, 8).forEach(c => {
  const inst = bootWithStorage({ [KEY]: JSON.stringify(c.bad) });
  const html = inst.appEl.innerHTML || "";
  ok(`「${c.name}」时首页正常渲染`,
    html.length > 500 && html.includes("欢迎回来"),
    `渲染 ${html.length} 字符`);
});

/* 这是原始故障的核心断言 */
{
  const inst = bootWithStorage({
    [KEY]: JSON.stringify({ records: [], wrong: null, favorites: "x", daily: 123, streak: null })
  });
  const html = inst.appEl.innerHTML || "";
  ok("【核心】多字段同时异常时仍能显示题目",
    html.length > 500 && html.includes("按学科练习") && html.includes("高等数学"),
    `渲染 ${html.length} 字符`);
  ok("【核心】学科卡片数量正确",
    (html.match(/data-start-subject/g) || []).length === 12,
    `实际 ${(html.match(/data-start-subject/g) || []).length} 个`);
}

/* ============================================================
   三、题库本身不受本地数据影响
   ============================================================ */
console.log("\n【三】题库不受本地数据影响");

CASES.slice(0, 6).forEach(c => {
  const inst = bootWithStorage({ [KEY]: JSON.stringify(c.bad) });
  ok(`「${c.name}」时题库完整`, inst.BANK && inst.BANK.length === 100,
    `实际 ${inst.BANK ? inst.BANK.length : 0} 题`);
});

/* ============================================================
   四、正常数据不被破坏
   ============================================================ */
console.log("\n【四】正常数据应被完整保留");

{
  const good = {
    records: { "m-001": { attempts: 3, correct: 2, wrong: 1, lastResult: "correct", lastAt: 1000 } },
    wrong: { "m-002": { addedAt: 500, count: 1, cleared: false } },
    favorites: { "m-003": { addedAt: 600 } },
    exams: [{ id: "e1", at: 700, score: 80 }],
    daily: { "2026-01-01": { answered: 5, correct: 4 } },
    streak: { days: 3, lastDate: "2026-01-01" },
    review: { "m-001": { stage: 2, dueAt: 9999, lastAt: 1000, ease: 2.5, lapses: 0 } },
    notes: { "m-001": { text: "我的笔记", updatedAt: 800, createdAt: 700 } },
    goals: { dailyQuestions: 30, dailyMinutes: 0, updatedAt: 900 },
    settings: { theme: "dark", instantJudge: false, autoNext: true, fontSize: "lg" }
  };
  const inst = bootWithStorage({ [KEY]: JSON.stringify(good) });
  const d = inst.Store.data;

  ok("保留 records", d.records["m-001"] && d.records["m-001"].attempts === 3);
  ok("保留 wrong", d.wrong["m-002"] && d.wrong["m-002"].count === 1);
  ok("保留 favorites", !!d.favorites["m-003"]);
  ok("保留 exams", Array.isArray(d.exams) && d.exams.length === 1);
  ok("保留 daily", d.daily["2026-01-01"] && d.daily["2026-01-01"].answered === 5);
  ok("保留 streak", d.streak.days === 3);
  ok("保留 review", d.review["m-001"] && d.review["m-001"].stage === 2);
  ok("保留 notes", d.notes["m-001"] && d.notes["m-001"].text === "我的笔记");
  ok("保留 goals", d.goals.dailyQuestions === 30);
  ok("保留 settings", d.settings.theme === "dark" && d.settings.fontSize === "lg");
}

/* 部分字段缺失时应补默认值 */
{
  const partial = { records: { "m-001": { attempts: 1, correct: 1, wrong: 0, lastAt: 1 } } };
  const inst = bootWithStorage({ [KEY]: JSON.stringify(partial) });
  const d = inst.Store.data;
  ok("缺失字段补默认值", d.wrong && d.favorites && d.notes && d.goals && d.settings);
  ok("已有字段不被覆盖", d.records["m-001"].attempts === 1);
  ok("默认主题为 light", d.settings.theme === "light");
  ok("默认目标为 20 题", d.goals.dailyQuestions === 20);
}

/* ============================================================
   五、缓存策略
   ============================================================ */
console.log("\n【五】静态资源缓存策略");

{
  const serverSrc = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  /*
   * JS/HTML 必须用 no-cache（每次校验），不能用 max-age。
   * 早期用 max-age=60 会导致浏览器 60 秒内不请求服务端，
   * 从而出现「新 HTML + 旧 JS」的版本错配。
   */
  ok("静态资源使用 no-cache（而非 max-age）",
    /const cacheControl = "no-cache"/.test(serverSrc),
    "未找到 no-cache 策略");
  /*
   * 只检查 cache-control 头里是否还有 max-age。
   * 注意排除两类误报：
   *   - Cookie 的 `Max-Age=`（会话有效期，与缓存无关）
   *   - 注释中提到的历史写法
   */
  const cacheControlLines = serverSrc.split("\n")
    .filter(l => /cache-control/i.test(l) && !/^\s*\*/.test(l));
  const badCacheControl = cacheControlLines.filter(l => /max-age/i.test(l));
  ok("cache-control 中不再使用 max-age",
    badCacheControl.length === 0,
    badCacheControl.join(" | "));
  ok("返回 ETag 支持协商缓存", /"etag": entry\.etag/.test(serverSrc));
  ok("支持 304 响应", /304/.test(serverSrc));
}

/* ============================================================
   报告
   ============================================================ */
console.log("\n" + "=".repeat(66));
console.log(`通过：${pass}    失败：${fail}`);
if (problems.length) {
  console.log("\n✗ 问题：");
  problems.forEach(p => console.log("  - " + p));
} else {
  console.log("\n✓ 异常本地数据均能安全降级，题目始终可见。");
}
console.log("=".repeat(66));
process.exit(fail ? 1 : 0);
