/**
 * 界面渲染冒烟测试（开发用）
 * 用最小 DOM 桩加载三个脚本，逐个视图渲染，捕获运行时异常与未定义插值。
 * 运行： node test/smoke.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* ============================================================
   一、最小 DOM 桩
   ============================================================ */
const rendered = [];   // 记录每次 innerHTML 赋值

function makeEl(tag = "div") {
  const el = {
    tagName: String(tag).toUpperCase(),
    dataset: {},
    style: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)); },
      remove(...c) { c.forEach(x => this._s.delete(x)); },
      toggle(c, f) {
        const on = f === undefined ? !this._s.has(c) : !!f;
        on ? this._s.add(c) : this._s.delete(c);
        return on;
      },
      contains(c) { return this._s.has(c); }
    },
    textContent: "",
    _html: "",
    onclick: null, onchange: null, oninput: null, onkeydown: null,
    disabled: false, value: "", files: [], type: "",
    closest() { return null; },
    remove() {},
    appendChild() {},
    removeAttribute() {},
    setAttribute() {},
    getAttribute() { return null; },
    focus() {},
    click() { if (typeof this.onclick === "function") this.onclick({ target: this }); },
    querySelector() { return makeEl(); },
    querySelectorAll() { return []; }
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el._html = String(v); rendered.push(el._html); }
  });
  return el;
}

/* 预置导航按钮：模拟 index.html 中已存在的顶栏导航 */
const navButtons = {};
["home", "review", "practice", "exam", "wrong", "favorite", "notes", "stats", "knowledge", "settings"].forEach(v => {
  const b = makeEl("button");
  b.dataset.nav = v;
  navButtons[v] = b;
});

/* 预置「按学科练习」按钮：用于进入答题界面 */
const subjectBtn = makeEl("button");
subjectBtn.dataset.startSubject = "高等数学";

/* 预置左上角返回首页按钮 */
const homeBtn = makeEl("button");

const elCache = new Map();
const appEl = makeEl("main");
elCache.set("app", appEl);
elCache.set("homeBtn", homeBtn);

/**
 * 按选择器缓存元素，保证 querySelector("#x") 与 getElementById("x")
 * 返回同一个对象（真实 DOM 的语义），否则事件绑定会落到临时对象上。
 */
const selCache = new Map();
function queryOne(sel) {
  if (sel.startsWith("#")) {
    const id = sel.slice(1);
    return document.getElementById(id);
  }
  if (!selCache.has(sel)) selCache.set(sel, makeEl("div"));
  return selCache.get(sel);
}

const document = {
  documentElement: { dataset: {} },
  body: { dataset: {} },
  getElementById(id) {
    if (!elCache.has(id)) elCache.set(id, makeEl("div"));
    return elCache.get(id);
  },
  querySelector(sel) {
    if (sel === "#app") return appEl;
    return queryOne(sel);
  },
  querySelectorAll(sel) {
    if (sel === "[data-nav]") return Object.values(navButtons);
    if (sel === "[data-start-subject]") return [subjectBtn];
    if (sel === "[data-auth-tab]") return [];
    return [];
  },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {},
  removeEventListener() {}
};

/* localStorage 桩 */
const mem = {};
const localStorage = {
  getItem: (k) => (k in mem ? mem[k] : null),
  setItem: (k, v) => { mem[k] = String(v); },
  removeItem: (k) => { delete mem[k]; }
};

/* fetch 桩：模拟服务端不可用（本地模式） */
const fetch = () => Promise.reject(new Error("offline"));

const window = {
  scrollTo() {},
  addEventListener() {},
  confirm: () => true,
  localStorage,
  fetch
};

const sandbox = {
  window, document, localStorage, fetch,
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Promise,
  Blob: class { constructor() {} },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  URLSearchParams,
  FileReader: class { readAsText() {} },
  confirm: () => true,
  alert: () => {},
  navigator: { userAgent: "node" },
  scrollTo() {}
};

/**
 * 还原浏览器的全局对象语义：self === window === globalThis。
 * 否则 UMD 包装的模块（如 merge.js）会挂到 globalThis 而非 window 上，
 * 与真实浏览器行为不一致，导致测试假失败。
 * 注意：必须在合并 window 的属性之后再统一指向 sandbox 自身。
 */
Object.assign(sandbox, window);
sandbox.self = sandbox;
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

/* ============================================================
   二、加载脚本
   ============================================================ */
const base = path.join(__dirname, "..", "js");
["questions.js", "merge.js", "render.js", "api.js", "store.js", "app.js"].forEach(f => {
  const code = fs.readFileSync(path.join(base, f), "utf8");
  try {
    vm.runInContext(code, sandbox, { filename: f });
  } catch (e) {
    console.error(`✗ 加载 ${f} 失败：${e.message}`);
    console.error(e.stack.split("\n").slice(0, 6).join("\n"));
    process.exit(1);
  }
});

/* ============================================================
   三、断言工具
   ============================================================ */
let failed = 0, passed = 0;
const problems = [];

function check(name, fn) {
  const before = rendered.length;
  try {
    fn();
    // 检查最近一次渲染的 HTML
    const html = rendered[rendered.length - 1] || "";
    if (!html.trim()) {
      problems.push(`${name}：渲染结果为空`);
      failed++; return;
    }
    if (/undefined/.test(html)) {
      const m = html.match(/.{0,60}undefined.{0,60}/);
      problems.push(`${name}：HTML 中出现 undefined → …${m[0].replace(/\s+/g, " ")}…`);
      failed++; return;
    }
    if (/\[object Object\]/.test(html)) {
      problems.push(`${name}：HTML 中出现 [object Object]`);
      failed++; return;
    }
    passed++;
  } catch (e) {
    problems.push(`${name}：抛出异常 ${e.message}`);
    failed++;
  }
}

/* ============================================================
   四、逐个视图验证
   ============================================================ */
check("首页渲染", () => {
  navButtons.home.click();
});

check("练习设置页渲染", () => {
  navButtons.practice.click();
});

check("模拟考设置页渲染", () => {
  navButtons.exam.click();
});

check("错题本（空态）渲染", () => {
  navButtons.wrong.click();
});

check("收藏夹（空态）渲染", () => {
  navButtons.favorite.click();
});

check("学习统计渲染", () => {
  navButtons.stats.click();
});

check("设置页渲染", () => {
  navButtons.settings.click();
});

check("答题界面渲染（进入练习）", () => {
  navButtons.home.click();
  subjectBtn.click();            // 创建练习会话并切到答题视图
});

/* 答题界面应包含关键元素 */
const quizHtml = rendered[rendered.length - 1] || "";
[
  ["题干区", "q-stem"],
  ["答题卡", "答题卡"],
  ["进度条", "quiz-progress"],
  ["收藏按钮", "btnFav"],
  ["下一题按钮", "btnNext"]
].forEach(([label, needle]) => {
  if (quizHtml.includes(needle)) passed++;
  else { problems.push(`答题界面缺少${label}（未找到 "${needle}"）`); failed++; }
});

/* ============================================================
   五、判分与记录链路验证
   ============================================================ */
const S = sandbox.window.Store;
const BANK = sandbox.window.QUESTION_BANK;

check("答错 → 进入错题本", () => {
  const q = BANK.find(x => x.type === "single");
  const wrongIdx = q.options.findIndex((_, i) => !q.answer.includes(i));
  S.recordAnswer(q.id, false);
  if (S.wrongCount() !== 1) throw new Error(`错题数应为 1，实际 ${S.wrongCount()}`);
  if (S.wrongList()[0] !== q.id) throw new Error("错题 id 不匹配");
});

check("答对 → 标记已订正", () => {
  const id = S.wrongList()[0];
  S.recordAnswer(id, true);
  if (S.data.wrong[id].cleared !== true) throw new Error("未标记为已订正");
  if (S.wrongCount() !== 1) throw new Error("已订正题目应从列表保留，不应被删除");
});

check("收藏 / 取消收藏", () => {
  const q = BANK[0];
  if (S.toggleFavorite(q.id) !== true) throw new Error("收藏失败");
  if (S.favoriteCount() !== 1) throw new Error("收藏数应为 1");
  if (S.toggleFavorite(q.id) !== false) throw new Error("取消收藏失败");
  if (S.favoriteCount() !== 0) throw new Error("取消后收藏数应为 0");
});

check("统计聚合正确", () => {
  const st = S.stats();
  if (st.answered !== 2) throw new Error(`答题次数应为 2，实际 ${st.answered}`);
  if (st.correct !== 1) throw new Error(`答对数应为 1，实际 ${st.correct}`);
  if (st.accuracy !== 50) throw new Error(`正确率应为 50，实际 ${st.accuracy}`);
  if (st.streakDays !== 1) throw new Error(`连续天数应为 1，实际 ${st.streakDays}`);
});

check("考试记录写入与读取", () => {
  S.addExam({
    id: "test1", at: Date.now(), subject: "测试卷",
    total: 10, right: 8, score: 80, durationSec: 300, detail: []
  });
  const list = S.examList();
  if (list.length !== 1) throw new Error("考试记录未写入");
  if (list[0].score !== 80) throw new Error("考试分数不正确");
});

check("数据导出为合法 JSON", () => {
  const json = S.exportJSON();
  const parsed = JSON.parse(json);
  if (typeof parsed !== "object") throw new Error("导出内容不是对象");
  if (!parsed.records) throw new Error("导出内容缺少 records");
});

check("数据导入可还原", () => {
  const snapshot = S.exportJSON();
  S.resetAll();
  if (S.stats().answered !== 0) throw new Error("重置失败");
  S.importJSON(snapshot);
  if (S.stats().answered !== 2) throw new Error("导入后数据未还原");
});

check("错题本视图（有数据）渲染", () => {
  navButtons.wrong.click();
});

check("统计视图（有数据）渲染", () => {
  navButtons.stats.click();
});

check("设置视图渲染（含账号与服务端卡片）", () => {
  navButtons.settings.click();
  const html = rendered[rendered.length - 1] || "";
  if (!html.includes("账号")) throw new Error("设置页缺少账号卡片");
  if (!html.includes("服务端连接")) throw new Error("设置页缺少服务端卡片");
  if (!html.includes("返回首页")) throw new Error("设置页快捷键说明缺少「返回首页」");
});

check("登录视图渲染", () => {
  // 点击顶栏「登录 / 注册」按钮，走真实链路切到 login 视图
  const loginBtn = document.getElementById("loginBtn");
  if (typeof loginBtn.onclick !== "function") throw new Error("登录按钮未绑定事件");
  loginBtn.click();

  const html = rendered[rendered.length - 1] || "";
  [
    ["登录标签", "data-auth-tab=\"login\""],
    ["注册标签", "data-auth-tab=\"register\""],
    ["用户名输入", "authUsername"],
    ["密码输入", "authPassword"],
    ["本地模式入口", "authSkip"]
  ].forEach(([label, needle]) => {
    if (!html.includes(needle)) throw new Error(`登录页缺少${label}`);
  });
  if (!html.includes("登录学而刷题")) throw new Error("登录页标题缺失");
});

check("登录页错误提示渲染", () => {
  const html = rendered[rendered.length - 1] || "";
  // 未填用户名/密码提交时应给出提示而不是崩溃
  const form = document.getElementById("authForm");
  if (form && typeof form.onsubmit === "function") {
    form.onsubmit({ preventDefault() {} });
  }
  const after = rendered[rendered.length - 1] || "";
  if (!after.includes("请填写用户名和密码")) throw new Error("空提交未给出校验提示");
});

check("返回首页按钮已绑定并可用", () => {
  const hb = document.getElementById("homeBtn");
  if (typeof hb.onclick !== "function") throw new Error("返回首页按钮未绑定事件");
  // 先进入练习，再点返回首页
  navButtons.home.click();
  subjectBtn.click();
  const quizView = rendered[rendered.length - 1] || "";
  if (!quizView.includes("q-stem")) throw new Error("未进入答题界面");

  hb.click();
  const homeView = rendered[rendered.length - 1] || "";
  if (!homeView.includes("欢迎回来")) throw new Error("点击返回首页后未回到首页");
});

/* ============================================================
   五·五、进度合并逻辑（多端同步正确性）
   ============================================================ */

check("合并：答题次数取较大值", () => {
  const local = {
    records: { q1: { attempts: 5, correct: 4, wrong: 1, lastResult: "correct", lastAt: 200 } },
    wrong: {}, favorites: {}, exams: [], daily: {}, streak: { days: 0, lastDate: "" }
  };
  const remote = {
    records: { q1: { attempts: 3, correct: 2, wrong: 1, lastResult: "wrong", lastAt: 100 } },
    wrong: {}, favorites: {}, exams: [], daily: {}, streak: { days: 0, lastDate: "" }
  };
  const m = S.mergeProgress(local, remote);
  if (m.records.q1.attempts !== 5) throw new Error(`attempts 应为 5，实际 ${m.records.q1.attempts}`);
  if (m.records.q1.correct !== 4) throw new Error(`correct 应为 4，实际 ${m.records.q1.correct}`);
  if (m.records.q1.lastResult !== "correct") throw new Error("应保留较新的 lastResult");
});

check("合并：两端题目取并集", () => {
  const local = { records: { a: { attempts: 1, correct: 1, wrong: 0, lastAt: 1 } }, wrong: {}, favorites: {}, exams: [], daily: {}, streak: {} };
  const remote = { records: { b: { attempts: 2, correct: 0, wrong: 2, lastAt: 2 } }, wrong: {}, favorites: {}, exams: [], daily: {}, streak: {} };
  const m = S.mergeProgress(local, remote);
  if (!m.records.a || !m.records.b) throw new Error("应包含两端题目");
});

check("合并：错题本两端都订正才算订正", () => {
  const local = { records: {}, wrong: { q1: { addedAt: 1, count: 2, cleared: true } }, favorites: {}, exams: [], daily: {}, streak: {} };
  const remote = { records: {}, wrong: { q1: { addedAt: 2, count: 3, cleared: false } }, favorites: {}, exams: [], daily: {}, streak: {} };
  const m = S.mergeProgress(local, remote);
  if (m.wrong.q1.cleared !== false) throw new Error("一端未订正则应为未订正");
  if (m.wrong.q1.count !== 3) throw new Error(`count 应取较大值 3，实际 ${m.wrong.q1.count}`);

  const both = S.mergeProgress(
    { records: {}, wrong: { q1: { addedAt: 1, count: 1, cleared: true } }, favorites: {}, exams: [], daily: {}, streak: {} },
    { records: {}, wrong: { q1: { addedAt: 2, count: 1, cleared: true } }, favorites: {}, exams: [], daily: {}, streak: {} }
  );
  if (both.wrong.q1.cleared !== true) throw new Error("两端都订正应为已订正");
});

check("合并：收藏取并集", () => {
  const local = { records: {}, wrong: {}, favorites: { f1: { addedAt: 1 } }, exams: [], daily: {}, streak: {} };
  const remote = { records: {}, wrong: {}, favorites: { f2: { addedAt: 2 } }, exams: [], daily: {}, streak: {} };
  const m = S.mergeProgress(local, remote);
  if (!m.favorites.f1 || !m.favorites.f2) throw new Error("收藏应为并集");
});

check("合并：考试记录按 id 去重且按时间倒序", () => {
  const local = { records: {}, wrong: {}, favorites: {}, exams: [{ id: "e1", at: 100, score: 80 }], daily: {}, streak: {} };
  const remote = { records: {}, wrong: {}, favorites: {}, exams: [{ id: "e1", at: 100, score: 80 }, { id: "e2", at: 200, score: 90 }], daily: {}, streak: {} };
  const m = S.mergeProgress(local, remote);
  if (m.exams.length !== 2) throw new Error(`考试记录应去重为 2 条，实际 ${m.exams.length}`);
  if (m.exams[0].id !== "e2") throw new Error("应按时间倒序，最新的在前");
});

check("合并：每日统计逐日取较大值", () => {
  const local = { records: {}, wrong: {}, favorites: {}, exams: [], daily: { "2026-01-01": { answered: 10, correct: 8 } }, streak: {} };
  const remote = { records: {}, wrong: {}, favorites: {}, exams: [], daily: { "2026-01-01": { answered: 6, correct: 6 }, "2026-01-02": { answered: 3, correct: 2 } }, streak: {} };
  const m = S.mergeProgress(local, remote);
  if (m.daily["2026-01-01"].answered !== 10) throw new Error("应取较大值 10");
  if (m.daily["2026-01-01"].correct !== 8) throw new Error("correct 应取较大值 8");
  if (!m.daily["2026-01-02"]) throw new Error("应合并新增日期");
});

check("合并：连续打卡取较大天数", () => {
  const m = S.mergeProgress(
    { records: {}, wrong: {}, favorites: {}, exams: [], daily: {}, streak: { days: 3, lastDate: "2026-01-01" } },
    { records: {}, wrong: {}, favorites: {}, exams: [], daily: {}, streak: { days: 7, lastDate: "2026-01-05" } }
  );
  if (m.streak.days !== 7) throw new Error(`应取 7，实际 ${m.streak.days}`);
  if (m.streak.lastDate !== "2026-01-05") throw new Error("应取较晚日期");
});

check("合并：空数据不报错", () => {
  const m = S.mergeProgress({}, {});
  if (!m.records || !m.wrong || !m.favorites) throw new Error("空数据合并应返回完整结构");
});

/* ============================================================
   五·六、公式渲染与安全
   ============================================================ */
const R = sandbox.window.Render;

check("公式渲染：无公式文本走纯转义", () => {
  const out = R.rich("普通文本 <script>alert(1)</script>");
  if (out.includes("<script>")) throw new Error("XSS 未转义！");
  if (!out.includes("&lt;script&gt;")) throw new Error("应转义为实体");
});

check("公式渲染：XSS 攻击载荷被拦截", () => {
  const attacks = [
    '<img src=x onerror=alert(1)>',
    '"><script>alert(1)</script>',
    "<svg/onload=alert(1)>",
    '<iframe src="javascript:alert(1)">'
  ];
  attacks.forEach(a => {
    const out = R.rich(a);
    // 正确行为：尖括号被转义为实体，因此不存在**可执行的真实标签**。
    // 判定标准是「有无未转义的标签起始」，而非是否包含标签文本。
    if (/<(img|svg|script|iframe)\b/i.test(out)) {
      throw new Error(`XSS 载荷产生了真实标签：${a} → ${out}`);
    }
    // 同时确认确实做了转义（而非原样输出）
    if (!out.includes("&lt;")) {
      throw new Error(`未对尖括号转义：${a} → ${out}`);
    }
  });
});

check("公式渲染：KaTeX trust 关闭（禁止 \\href 等危险指令）", () => {
  // 未加载 KaTeX 时应降级为转义文本，不产生可点击链接
  const out = R.rich("$\\href{javascript:alert(1)}{click}$");
  if (/href\s*=\s*["']?javascript:/i.test(out)) {
    throw new Error("危险 href 未被拦截");
  }
});

check("公式渲染：KaTeX 未加载时优雅降级", () => {
  if (R.hasKatex()) return;   // 本测试环境无 KaTeX
  const out = R.rich("公式 $x^2$ 结束");
  if (!out.includes("x^2")) throw new Error("降级后应保留公式原文");
  if (out.includes("<script")) throw new Error("降级路径存在 XSS");
});

check("公式渲染：定界符识别正确", () => {
  if (R.hasKatex()) return;
  const cases = [
    ["$x^2$", true],
    ["$$\\int_0^1 x dx$$", true],
    ["\\(a+b\\)", true],
    ["\\[a+b\\]", true],
    ["普通文本没有公式", false],
    ["价格是 $5 元", false]     // $ 后跟数字不应识别为公式
  ];
  cases.forEach(([text, expect]) => {
    const got = R.hasMath(text);
    if (got !== expect) throw new Error(`「${text}」期望 hasMath=${expect}，实际 ${got}`);
  });
});

check("公式渲染：题干中的公式被正确包裹", () => {
  const q = BANK.find(x => x.id === "m-001");
  if (!q) throw new Error("找不到测试题 m-001");
  const out = R.rich(q.stem);
  if (out.includes("<script")) throw new Error("题干渲染存在 XSS");
  if (!out.length) throw new Error("题干渲染为空");
});

/* ============================================================
   五·七、知识点标签
   ============================================================ */
check("知识点：每题都有标签", () => {
  const missing = BANK.filter(q => !Array.isArray(q.knowledge) || !q.knowledge.length);
  if (missing.length) throw new Error(`${missing.length} 道题缺少知识点标签：${missing.slice(0, 3).map(q => q.id).join(",")}`);
});

check("知识点：标签无重复且非空", () => {
  BANK.forEach(q => {
    if (new Set(q.knowledge).size !== q.knowledge.length) throw new Error(`${q.id} 标签重复`);
    q.knowledge.forEach(k => {
      if (typeof k !== "string" || !k.trim()) throw new Error(`${q.id} 存在空标签`);
    });
  });
});

check("知识点：无近义碎片（受控词表）", () => {
  const tags = new Set(BANK.flatMap(q => q.knowledge));
  // 这些是历史遗留的碎片标签，不应再出现
  const forbidden = ["点电荷场强", "操作系统功能", "双缝干涉", "机械波传播", "宪法地位", "有限理性决策"];
  const found = forbidden.filter(t => tags.has(t));
  if (found.length) throw new Error(`发现应被归并的碎片标签：${found.join("、")}`);
});

check("知识点：总数量在合理范围（避免过度碎片化）", () => {
  const tags = new Set(BANK.flatMap(q => q.knowledge));
  if (tags.size > 90) throw new Error(`知识点过多（${tags.size} 个），热力图将不可用`);
  if (tags.size < 20) throw new Error(`知识点过少（${tags.size} 个），粒度不足`);
});

/* ============================================================
   五·八、间隔重复
   ============================================================ */
check("复习：答对后间隔递增", () => {
  const t0 = 1700000000000;
  const r1 = S.scheduleReview(undefined, true, t0);
  const r2 = S.scheduleReview(r1, true, t0);
  if (!(r2.dueAt > r1.dueAt)) throw new Error("第二次答对的间隔应更长");
});

check("复习：答错后间隔缩短", () => {
  const t0 = 1700000000000;
  let r = S.scheduleReview(undefined, true, t0);
  r = S.scheduleReview(r, true, t0);
  r = S.scheduleReview(r, true, t0);
  const before = r.dueAt - t0;
  const after = S.scheduleReview(r, false, t0);
  if (!((after.dueAt - t0) < before)) throw new Error("答错后应缩短复习间隔");
});

check("复习：dueList 只返回已到期题目", () => {
  const now = Date.now();
  const map = {
    past: { stage: 1, dueAt: now - 1000, lastAt: 0 },
    future: { stage: 3, dueAt: now + 86400000 * 5, lastAt: 0 }
  };
  const due = S.dueForReview(map, now);
  if (!due.includes("past")) throw new Error("应包含已到期题目");
  if (due.includes("future")) throw new Error("不应包含未到期题目");
});

check("复习视图渲染", () => {
  navButtons.review.click();
  const html = rendered[rendered.length - 1] || "";
  if (!html.includes("复习")) throw new Error("复习页渲染异常");
});

check("知识点视图渲染", () => {
  navButtons.knowledge.click();
  const html = rendered[rendered.length - 1] || "";
  if (!html.includes("知识点")) throw new Error("知识点页渲染异常");
});

check("答题记录会推进复习调度", () => {
  const q = BANK.find(x => x.type === "single");
  S.recordAnswer(q.id, true);
  const r = S.getReview(q.id);
  if (!r) throw new Error("答题后未生成复习计划");
  if (!(r.dueAt > Date.now())) throw new Error("答对后到期时间应在未来");
});

/* ============================================================
   五·九、个人笔记
   ============================================================ */
check("笔记：保存与读取", () => {
  const q = BANK[0];
  S.saveNote(q.id, "这题我总忘记讨论 x=0 的情况");
  const n = S.getNote(q.id);
  if (!n) throw new Error("保存后读不到笔记");
  if (n.text !== "这题我总忘记讨论 x=0 的情况") throw new Error("笔记内容不一致");
  if (!(n.updatedAt > 0)) throw new Error("缺少 updatedAt");
  if (!(n.createdAt > 0)) throw new Error("缺少 createdAt");
});

check("笔记：更新保留 createdAt", () => {
  const q = BANK[1];
  S.saveNote(q.id, "第一版");
  const created = S.data.notes[q.id].createdAt;
  S.saveNote(q.id, "第二版");
  const n = S.getNote(q.id);
  if (n.text !== "第二版") throw new Error("更新未生效");
  if (n.createdAt !== created) throw new Error("更新不应改变 createdAt");
});

check("笔记：长度截断保护", () => {
  const q = BANK[2];
  S.saveNote(q.id, "x".repeat(5000));
  const n = S.getNote(q.id);
  if (n.text.length > 2000) throw new Error(`笔记未截断，长度 ${n.text.length}`);
});

check("笔记：空文本表示删除且保留删除意图", () => {
  const q = BANK[3];
  S.saveNote(q.id, "待删除");
  if (!S.getNote(q.id)) throw new Error("前置条件失败");
  S.saveNote(q.id, "   ");
  if (S.getNote(q.id)) throw new Error("空文本后仍能读到笔记（应视为删除）");
  // 但记录本身要保留（带更新时间），否则删除无法同步到其他设备
  if (!S.data.notes[q.id]) throw new Error("删除意图未保留，无法同步");
  if (!(S.data.notes[q.id].updatedAt > 0)) throw new Error("删除记录缺少时间戳");
});

check("笔记：noteList 只含有内容的笔记", () => {
  const list = S.noteList();
  list.forEach(id => {
    const n = S.data.notes[id];
    if (!n || !n.text || !n.text.trim()) throw new Error(`${id} 是无内容笔记，不应出现在列表`);
  });
  if (!list.length) throw new Error("应至少有一条笔记");
});

check("笔记：noteList 按更新时间倒序", () => {
  const list = S.noteList();
  for (let i = 1; i < list.length; i++) {
    const prev = S.data.notes[list[i - 1]].updatedAt || 0;
    const cur = S.data.notes[list[i]].updatedAt || 0;
    if (prev < cur) throw new Error("笔记列表未按更新时间倒序");
  }
});

check("笔记：删除笔记", () => {
  const q = BANK[4];
  S.saveNote(q.id, "临时笔记");
  const before = S.noteCount();
  S.deleteNote(q.id);
  if (S.getNote(q.id)) throw new Error("删除后仍能读到");
  if (S.noteCount() !== before - 1) throw new Error("笔记数未减少");
});

check("笔记：合并满足 LWW（取较新）", () => {
  const M2 = sandbox.window.QuizMerge;
  const a = M2.emptyProgress();
  a.notes["q1"] = { text: "旧", updatedAt: 1000, createdAt: 500 };
  const b = M2.emptyProgress();
  b.notes["q1"] = { text: "新", updatedAt: 2000, createdAt: 500 };
  const m = M2.mergeProgress(a, b);
  if (m.notes["q1"].text !== "新") throw new Error(`应取较新的「新」，实际「${m.notes["q1"].text}」`);
});

check("笔记：合并满足交换律", () => {
  const M2 = sandbox.window.QuizMerge;
  const a = M2.emptyProgress();
  a.notes["q1"] = { text: "A端", updatedAt: 1000, createdAt: 1 };
  const b = M2.emptyProgress();
  b.notes["q1"] = { text: "B端", updatedAt: 2000, createdAt: 1 };
  const ab = JSON.stringify(M2.mergeProgress(a, b));
  const ba = JSON.stringify(M2.mergeProgress(b, a));
  if (ab !== ba) throw new Error("笔记合并不满足交换律");
});

check("笔记：同时间戳合并结果确定（交换律边界）", () => {
  const M2 = sandbox.window.QuizMerge;
  const a = M2.emptyProgress();
  a.notes["q1"] = { text: "短", updatedAt: 1000, createdAt: 1 };
  const b = M2.emptyProgress();
  b.notes["q1"] = { text: "较长的文本", updatedAt: 1000, createdAt: 1 };
  const ab = JSON.stringify(M2.mergeProgress(a, b));
  const ba = JSON.stringify(M2.mergeProgress(b, a));
  if (ab !== ba) throw new Error("时间戳相同时合并结果不确定，破坏交换律");
});

check("笔记：两端不同题目笔记取并集", () => {
  const M2 = sandbox.window.QuizMerge;
  const a = M2.emptyProgress();
  a.notes["q1"] = { text: "A", updatedAt: 1, createdAt: 1 };
  const b = M2.emptyProgress();
  b.notes["q2"] = { text: "B", updatedAt: 2, createdAt: 2 };
  const m = M2.mergeProgress(a, b);
  if (!m.notes["q1"] || !m.notes["q2"]) throw new Error("笔记应取并集");
});

check("笔记视图渲染", () => {
  navButtons.notes.click();
  const html = rendered[rendered.length - 1] || "";
  if (!html.includes("笔记")) throw new Error("笔记页渲染异常");
  if (!html.includes("我的笔记")) throw new Error("缺少标题");
});

/* ============================================================
   五·十、每日目标
   ============================================================ */
check("目标：默认值为 20 题", () => {
  const g = S.goals();
  if (g.dailyQuestions !== 20) throw new Error(`默认应为 20，实际 ${g.dailyQuestions}`);
});

check("目标：设置与读取", () => {
  S.setGoals({ dailyQuestions: 35 });
  if (S.goals().dailyQuestions !== 35) throw new Error("设置未生效");
  S.setGoals({ dailyQuestions: 20 });   // 还原
});

check("目标：数值范围钳制", () => {
  S.setGoals({ dailyQuestions: 99999 });
  if (S.goals().dailyQuestions > 500) throw new Error("上限未钳制");
  S.setGoals({ dailyQuestions: -5 });
  if (S.goals().dailyQuestions < 0) throw new Error("下限未钳制");
  S.setGoals({ dailyQuestions: 20 });
});

check("目标：进度计算正确", () => {
  const gp = S.goalProgress();
  if (typeof gp.done !== "number") throw new Error("缺少 done");
  if (typeof gp.target !== "number") throw new Error("缺少 target");
  if (typeof gp.percent !== "number") throw new Error("缺少 percent");
  if (gp.percent < 0 || gp.percent > 100) throw new Error(`percent 越界：${gp.percent}`);
  if (typeof gp.met !== "boolean") throw new Error("缺少 met");
  if (gp.remain < 0) throw new Error("remain 不应为负");
});

check("目标：百分比封顶 100", () => {
  const M2 = sandbox.window.QuizMerge;
  const today = M2.dayKey();
  const p = M2.emptyProgress();
  p.goals = { dailyQuestions: 5, updatedAt: 1 };
  p.daily[today] = { answered: 99, correct: 90 };
  const gp = M2.goalProgress(p);
  if (gp.percent !== 100) throw new Error(`应封顶 100，实际 ${gp.percent}`);
  if (!gp.met) throw new Error("超额完成应视为达成");
  if (gp.remain !== 0) throw new Error("超额时 remain 应为 0");
});

check("目标：未设目标时不计算百分比", () => {
  const M2 = sandbox.window.QuizMerge;
  const p = M2.emptyProgress();
  p.goals = { dailyQuestions: 0, updatedAt: 1 };
  p.daily[M2.dayKey()] = { answered: 10, correct: 8 };
  const gp = M2.goalProgress(p);
  if (gp.hasGoal) throw new Error("0 应视为不设目标");
  if (gp.percent !== 0) throw new Error("未设目标时 percent 应为 0");
  if (gp.met) throw new Error("未设目标不应视为达成");
});

check("目标：历史长度与结构", () => {
  const hist = S.goalHistory(14);
  if (hist.length !== 14) throw new Error(`应 14 天，实际 ${hist.length}`);
  const last = hist[hist.length - 1];
  if (typeof last.key !== "string" || typeof last.answered !== "number") {
    throw new Error("历史条目结构不正确");
  }
  // 最后一天应是今天
  const M2 = sandbox.window.QuizMerge;
  if (last.key !== M2.dayKey()) throw new Error("最后一天不是今天");
});

check("目标：合并取较新配置", () => {
  const M2 = sandbox.window.QuizMerge;
  const a = M2.emptyProgress();
  a.goals = { dailyQuestions: 10, dailyMinutes: 0, updatedAt: 1000 };
  const b = M2.emptyProgress();
  b.goals = { dailyQuestions: 40, dailyMinutes: 30, updatedAt: 2000 };
  const m = M2.mergeProgress(a, b);
  if (m.goals.dailyQuestions !== 40) throw new Error("应取较新的 40");
  if (m.goals.dailyMinutes !== 30) throw new Error("应取较新的 30");
});

check("目标：合并满足交换律", () => {
  const M2 = sandbox.window.QuizMerge;
  const a = M2.emptyProgress();
  a.goals = { dailyQuestions: 10, dailyMinutes: 5, updatedAt: 1000 };
  const b = M2.emptyProgress();
  b.goals = { dailyQuestions: 40, dailyMinutes: 30, updatedAt: 2000 };
  if (JSON.stringify(M2.mergeProgress(a, b).goals) !== JSON.stringify(M2.mergeProgress(b, a).goals)) {
    throw new Error("目标合并不满足交换律");
  }
});

check("目标：答题会累加到今日进度", () => {
  const M2 = sandbox.window.QuizMerge;
  const today = M2.dayKey();
  const before = (S.data.daily[today] || {}).answered || 0;
  S.recordAnswer(BANK[10].id, true);
  const after = (S.data.daily[today] || {}).answered || 0;
  if (after !== before + 1) throw new Error(`今日答题数应 +1：${before} → ${after}`);
});

check("首页渲染含目标卡片", () => {
  navButtons.home.click();
  const html = rendered[rendered.length - 1] || "";
  if (!html.includes("goal-card")) throw new Error("首页缺少目标卡片");
  if (!html.includes("目标")) throw new Error("目标卡片内容缺失");
});

check("设置页渲染含每日目标配置", () => {
  navButtons.settings.click();
  const html = rendered[rendered.length - 1] || "";
  if (!html.includes("每日目标")) throw new Error("设置页缺少每日目标区块");
  if (!html.includes("setGoalQ")) throw new Error("缺少题量选择器");
  if (!html.includes("setGoalM")) throw new Error("缺少时长选择器");
});

/* ============================================================
   六、报告
   ============================================================ */
console.log("=".repeat(56));
console.log("界面渲染冒烟测试");
console.log("=".repeat(56));
console.log(`通过：${passed}    失败：${failed}`);
console.log(`累计渲染 ${rendered.length} 次，最大 HTML 长度 ${Math.max(...rendered.map(h => h.length))} 字符`);

if (problems.length) {
  console.log("\n✗ 问题清单：");
  problems.forEach(p => console.log("  - " + p));
  process.exit(1);
} else {
  console.log("\n✓ 所有视图渲染正常，事件绑定与数据链路无异常。");
}
