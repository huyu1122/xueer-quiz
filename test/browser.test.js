/**
 * 真实浏览器交互测试（Edge headless + CDP）
 *
 * 为什么需要：DOM 桩测试无法发现真实浏览器中的问题 ——
 * 事件绑定、CSS 布局、KaTeX 渲染、localStorage、fetch 行为都可能不同。
 * 本测试用真实 Edge 加载真实页面，通过 Chrome DevTools Protocol 执行
 * 真实点击与输入，验证端到端可用性。
 *
 * 运行： node test/browser.test.js
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8920;
const CDP_PORT = 9333;

/* 查找可用的 Chromium 内核浏览器 */
function findBrowser() {
  const candidates = [
    process.env.QUIZ_BROWSER,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe"
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ============================================================
   极简 CDP 客户端（用 WebSocket 手写，避免引入依赖）
   ============================================================ */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws = null;
  }

  async connect() {
    const WebSocket = require("ws");
    this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    await new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
    this.ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 20000);
    });
  }

  /** 在页面中执行 JS 并返回结果 */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error("页面 JS 异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  close() { try { this.ws && this.ws.close(); } catch {} }
}

/* ============================================================
   测试框架
   ============================================================ */
let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); console.log(`  ✗ ${name}${detail ? " → " + detail : ""}`); }
};

/* ============================================================
   主流程
   ============================================================ */
async function main() {
  console.log("=".repeat(66));
  console.log("真实浏览器交互测试（Edge headless + CDP）");
  console.log("=".repeat(66));

  /* 检查 ws 模块是否可用 */
  let hasWs = true;
  try { require.resolve("ws"); } catch { hasWs = false; }

  if (!hasWs) {
    console.log("\n⚠ 未找到 ws 模块，无法使用 CDP。");
    console.log("  改用 --dump-dom 做静态渲染验证（覆盖较弱）。");
    console.log("  安装 ws 后可运行完整交互测试： npm i ws");
    return await fallbackDomTest();
  }

  const browser = findBrowser();
  if (!browser) {
    console.log("\n⚠ 未找到 Chromium 内核浏览器，跳过浏览器测试。");
    return;
  }
  console.log(`\n浏览器：${browser}`);

  /* ---------- 启动服务 ---------- */
  const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-browser-"));
  const serverProc = spawn(process.execPath, [
    path.join(ROOT, "server", "server.js"), "--port", String(PORT), "--no-open", "--quiet"
  ], {
    cwd: ROOT,
    env: { ...process.env, QUIZ_DATA_DIR: TEST_DATA, QUIZ_RL_REGISTER: "100" },
    stdio: "ignore"
  });

  /* 等服务就绪 */
  let up = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await new Promise((res, rej) => {
        const q = http.get({ host: "127.0.0.1", port: PORT, path: "/api/meta", timeout: 1000 }, (r2) => {
          r2.resume(); res(r2.statusCode);
        });
        q.on("error", rej); q.on("timeout", () => { q.destroy(); rej(new Error("t")); });
      });
      if (r === 200) { up = true; break; }
    } catch {}
    await sleep(250);
  }
  if (!up) {
    console.log("  ✗ 服务未能启动");
    serverProc.kill();
    try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }
  console.log(`服务：http://127.0.0.1:${PORT}\n`);

  /* ---------- 启动浏览器 ---------- */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-prof-"));
  const browserProc = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "about:blank"
  ], { stdio: "ignore" });

  /* 等 CDP 就绪 */
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await new Promise((res, rej) => {
        const q = http.get({ host: "127.0.0.1", port: CDP_PORT, path: "/json/list", timeout: 1000 }, (r) => {
          let s = ""; r.on("data", c => s += c); r.on("end", () => res(JSON.parse(s)));
        });
        q.on("error", rej); q.on("timeout", () => { q.destroy(); rej(new Error("t")); });
      });
      const page = list.find(t => t.type === "page");
      if (page && page.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(300);
  }

  if (!wsUrl) {
    console.log("  ✗ 无法连接浏览器调试端口");
    browserProc.kill(); serverProc.kill();
    try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); fs.rmSync(profile, { recursive: true, force: true }); } catch {}
    process.exit(1);
  }

  const cdp = new CDP(wsUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  /* 收集页面控制台错误 */
  const consoleErrors = [];
  cdp.ws.on("message", (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.method === "Runtime.exceptionThrown") {
      consoleErrors.push(m.params.exceptionDetails?.exception?.description
        || m.params.exceptionDetails?.text || "未知异常");
    }
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description).join(" "));
    }
  });

  try {
    /* ============ 1. 页面加载 ============ */
    console.log("【1】页面加载");
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3000);

    ok("页面标题正确", (await cdp.eval("document.title")).includes("刷题"));
    ok("应用已渲染", (await cdp.eval("document.getElementById('app').innerHTML.length")) > 500);
    ok("欢迎语可见", (await cdp.eval("document.body.innerText")).includes("欢迎回来"));

    /* 全局对象 */
    ok("题库已加载", (await cdp.eval("Array.isArray(window.QUESTION_BANK) && window.QUESTION_BANK.length")) > 0);
    ok("合并模块已加载", (await cdp.eval("typeof window.QuizMerge === 'object'")));
    ok("渲染模块已加载", (await cdp.eval("typeof window.Render === 'object'")));
    ok("Store 已加载", (await cdp.eval("typeof window.Store === 'object'")));
    ok("Api 已加载", (await cdp.eval("typeof window.Api === 'object'")));

    /* KaTeX 渲染检查放在进入答题界面之后 —— 首页不含题干，本就不会有公式 */
    ok("KaTeX 脚本已加载", (await cdp.eval("typeof window.katex === 'object' && typeof window.katex.renderToString === 'function'")));

    /* ============ 2. 进入练习并答题 ============ */
    console.log("\n【2】练习答题流程");

    /* 点击第一个学科卡片 */
    await cdp.eval(`(function(){
      var b = document.querySelector('[data-start-subject]');
      if (b) b.click();
      return !!b;
    })()`);
    await sleep(800);

    ok("已进入答题界面", (await cdp.eval("!!document.querySelector('.q-stem')")));
    ok("答题卡已渲染", (await cdp.eval("document.querySelectorAll('.sheet-cell').length")) > 0);

    /*
     * 公式渲染：进入答题界面后才可能出现 .katex。
     * 用「题库中所有含公式的题」逐题验证，比只看第一题更可靠
     * （第一题可能恰好不含公式）。
     */
    const katexCheck = await cdp.eval(`(function(){
      // 检查当前题干是否含公式且已渲染
      var stemEl = document.querySelector('.q-stem');
      var hasDollar = /\\$[^\\s$]/.test(stemEl ? stemEl.textContent : '');
      var katexEls = document.querySelectorAll('.q-stem .katex, .option-text .katex, .analysis .katex').length;
      // 直接调用渲染模块验证公式可渲染
      var testHtml = window.Render.rich('测试 $\\\\lim\\\\limits_{x \\\\to 0} \\\\dfrac{\\\\sin x}{x}$ 结束');
      return {
        stemHasDollar: hasDollar,
        katexInQuiz: katexEls,
        renderWorks: testHtml.indexOf('katex') >= 0,
        renderHasMathML: testHtml.indexOf('katex-mathml') >= 0,
        scriptLoaded: typeof window.katex === 'object'
      };
    })()`);

    ok("KaTeX 库已加载", katexCheck.scriptLoaded);
    ok("渲染模块能产出 KaTeX 结构", katexCheck.renderWorks);
    ok("产出含 MathML（可访问性）", katexCheck.renderHasMathML);

    /* 逐题翻页，统计实际渲染出的公式数量 */
    const formulaPages = await cdp.eval(`(function(){
      var found = 0, checked = 0, total = document.querySelectorAll('.sheet-cell').length;
      var limit = Math.min(total, 30);
      for (var i = 0; i < limit; i++) {
        var cell = document.querySelector('[data-jump="' + i + '"]');
        if (!cell) continue;
        cell.click();
        checked++;
        if (document.querySelector('.q-stem .katex')) found++;
      }
      return { found: found, checked: checked };
    })()`);
    ok("答题过程中真实渲染出公式", formulaPages.found > 0,
      `检查 ${formulaPages.checked} 题，含公式 ${formulaPages.found} 题`);

    /*
     * 答题测试：先回到第 1 题。
     * 上面的公式遍历会停在最后一题，而那一题可能是填空题（无选项），
     * 因此必须显式跳回一道**选择题**再作答。
     */
    const picked = await cdp.eval(`(function(){
      // 找一道有选项的题（跳过填空）
      var cells = document.querySelectorAll('.sheet-cell');
      for (var i = 0; i < cells.length; i++) {
        cells[i].click();
        if (document.querySelectorAll('[data-opt]').length > 0) {
          return { index: i, optCount: document.querySelectorAll('[data-opt]').length };
        }
      }
      return { index: -1, optCount: 0 };
    })()`);
    ok("能定位到有选项的题目", picked.optCount > 0, `index=${picked.index}`);

    /* 读取当前题正确答案，点击正确选项 */
    const answerResult = await cdp.eval(`(function(){
      var stem = document.querySelector('.q-stem');
      if (!stem) return {err:'无题干'};
      var opts = document.querySelectorAll('[data-opt]');
      if (!opts.length) return {err:'当前题无选项（可能是填空题）'};
      var stemText = stem.textContent.replace(/\\s+/g,'');
      var bank = window.QUESTION_BANK;
      var q = null;
      for (var i=0;i<bank.length;i++){
        if (bank[i].type === 'fill') continue;
        var s = bank[i].stem.replace(/\\$[^$]*\\$/g,'').replace(/\\s+/g,'');
        if (s.length > 8 && stemText.indexOf(s.slice(0,12)) >= 0) { q = bank[i]; break; }
      }
      var correctIdx = q ? q.answer[0] : 0;
      if (correctIdx >= opts.length) correctIdx = 0;
      opts[correctIdx].click();
      return {qid: q ? q.id : null, correctIdx: correctIdx, optCount: opts.length};
    })()`);

    ok("能定位题目并点击选项", !answerResult.err, answerResult.err || "");
    await sleep(900);

    /* 判分后应出现解析 */
    ok("答后显示解析", (await cdp.eval("!!document.querySelector('.analysis')")));
    ok("解析区显示对错", /回答(正确|错误)/.test(await cdp.eval("document.body.innerText")));

    /* 答题记录已写入 localStorage */
    const recCount = await cdp.eval(`(function(){
      try {
        var d = JSON.parse(localStorage.getItem('xueer-quiz-v1') || '{}');
        return Object.keys(d.records || {}).length;
      } catch(e) { return -1; }
    })()`);
    ok("答题记录已持久化", recCount > 0, `records=${recCount}`);

    /* 复习计划已生成 */
    const reviewCount = await cdp.eval(`(function(){
      try {
        var d = JSON.parse(localStorage.getItem('xueer-quiz-v1') || '{}');
        return Object.keys(d.review || {}).length;
      } catch(e) { return -1; }
    })()`);
    ok("复习计划已生成", reviewCount > 0, `review=${reviewCount}`);

    /* ============ 3. 笔记功能 ============ */
    console.log("\n【3】笔记功能");

    const noteOpened = await cdp.eval(`(function(){
      var b = document.getElementById('btnNote');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    ok("笔记按钮可点击", noteOpened);
    await sleep(500);
    ok("笔记编辑弹窗已打开", (await cdp.eval("!!document.getElementById('noteText')")));

    /* 输入笔记并保存 */
    await cdp.eval(`(function(){
      var ta = document.getElementById('noteText');
      if (!ta) return false;
      ta.value = '浏览器测试笔记：注意 x=0 的情况';
      ta.dispatchEvent(new Event('input', {bubbles:true}));
      var save = document.querySelector('[data-save]');
      if (save) save.click();
      return true;
    })()`);
    await sleep(700);

    const savedNote = await cdp.eval(`(function(){
      try {
        var d = JSON.parse(localStorage.getItem('xueer-quiz-v1') || '{}');
        var ks = Object.keys(d.notes || {});
        return ks.length ? d.notes[ks[0]].text : '';
      } catch(e) { return 'ERR:' + e.message; }
    })()`);
    ok("笔记已保存到本地", savedNote.includes("浏览器测试笔记"), `实际「${savedNote}」`);

    /* ============ 4. 视图切换 ============ */
    console.log("\n【4】各视图切换");

    const views = [
      ["home", "欢迎回来"],
      ["review", "复习"],
      ["practice", "练习"],
      ["exam", "模拟考"],
      ["wrong", "错题本"],
      ["favorite", "收藏"],
      ["notes", "笔记"],
      ["stats", "统计"],
      ["knowledge", "知识点"],
      ["settings", "设置"]
    ];

    for (const [nav, expect] of views) {
      const res = await cdp.eval(`(function(){
        var b = document.querySelector('[data-nav="${nav}"]');
        if (!b) return 'no-button';
        b.click();
        return document.getElementById('app').innerHTML.length;
      })()`);
      await sleep(320);
      const len = await cdp.eval("document.getElementById('app').innerHTML.length");
      const txt = await cdp.eval("document.getElementById('app').innerText.slice(0,400)");
      ok(`视图「${nav}」渲染正常`, typeof res === "number" && len > 100 && txt.includes(expect),
        `len=${len}`);
    }

    /* ============ 5. 返回首页按钮 ============ */
    console.log("\n【5】返回首页按钮");

    /* 先回首页，再从学科卡片进入答题界面（[data-start-subject] 只在首页存在） */
    await cdp.eval(`document.querySelector('[data-nav="home"]').click()`);
    await sleep(500);
    ok("已回到首页", (await cdp.eval("!!document.querySelector('[data-start-subject]')")));

    await cdp.eval(`(function(){
      var b = document.querySelector('[data-start-subject]');
      if (b) b.click();
    })()`);
    await sleep(700);
    ok("已进入答题界面", (await cdp.eval("!!document.querySelector('.q-stem')")));

    /* 答题中途点返回首页 */
    const homeBtnExists = await cdp.eval("!!document.getElementById('homeBtn')");
    ok("返回首页按钮存在", homeBtnExists);
    await cdp.eval(`document.getElementById('homeBtn').click()`);
    await sleep(700);
    ok("点击返回首页后回到首页",
      (await cdp.eval("document.body.innerText")).includes("欢迎回来"));

    /* 在设置页也应能返回首页 */
    await cdp.eval(`document.querySelector('[data-nav="settings"]').click()`);
    await sleep(500);
    await cdp.eval(`document.getElementById('homeBtn').click()`);
    await sleep(600);
    ok("从设置页也能返回首页",
      (await cdp.eval("document.body.innerText")).includes("欢迎回来"));

    /* ============ 6. 主题切换 ============ */
    console.log("\n【6】主题切换");
    const themeBefore = await cdp.eval("document.documentElement.dataset.theme");
    await cdp.eval(`document.getElementById('themeToggle').click()`);
    await sleep(400);
    const themeAfter = await cdp.eval("document.documentElement.dataset.theme");
    ok("主题可切换", themeBefore !== themeAfter, `${themeBefore} → ${themeAfter}`);

    /* ============ 6b. 空状态视图（回归测试） ============ */
    /*
     * 这一组是真实浏览器发现的 bug 的回归测试：
     * 错题本 / 收藏夹为空时，视图渲染的是空状态 HTML（不含 #wPractice 等按钮），
     * 但绑定函数仍无条件访问这些元素，导致
     * "Cannot set properties of null (setting 'onclick')"，
     * 使空状态视图无法正常渲染。
     *
     * 必须逐个访问空状态视图并确认没有 JS 异常。
     */
    console.log("\n【6b】空状态视图（回归）");

    /* 先清空错题本与收藏，制造空状态 */
    await cdp.eval(`(function(){
      try {
        window.Store.clearWrong();
        var favs = window.Store.favoriteList();
        favs.forEach(function(id){ window.Store.toggleFavorite(id); });
        return true;
      } catch(e) { return false; }
    })()`);
    await sleep(500);

    const emptyStateErrorsBefore = consoleErrors.length;

    /* 错题本与收藏此时确为空，应渲染空状态 */
    for (const [nav, label] of [["wrong", "错题本"], ["favorite", "收藏"]]) {
      await cdp.eval(`document.querySelector('[data-nav="${nav}"]').click()`);
      await sleep(450);
      const info = await cdp.eval(`(function(){
        var app = document.getElementById('app');
        return {
          len: app.innerHTML.length,
          hasEmpty: !!app.querySelector('.empty')
        };
      })()`);
      ok(`空状态「${label}」正常渲染`, info.len > 100 && info.hasEmpty,
        `len=${info.len} hasEmpty=${info.hasEmpty}`);
    }

    /* 笔记此时**有内容**（前面创建过），应渲染列表而非空状态 */
    await cdp.eval(`document.querySelector('[data-nav="notes"]').click()`);
    await sleep(450);
    const notesWithContent = await cdp.eval(`(function(){
      var app = document.getElementById('app');
      return {
        len: app.innerHTML.length,
        hasEmpty: !!app.querySelector('.empty'),
        hasNoteBody: !!app.querySelector('.note-body')
      };
    })()`);
    ok("笔记视图（有内容）渲染列表", notesWithContent.hasNoteBody && !notesWithContent.hasEmpty,
      `len=${notesWithContent.len} hasNoteBody=${notesWithContent.hasNoteBody}`);

    /* 清空笔记后应转为空状态 */
    await cdp.eval(`(function(){
      window.Store.noteList().forEach(function(id){ window.Store.deleteNote(id); });
      document.querySelector('[data-nav="home"]').click();
      return true;
    })()`);
    await sleep(400);
    await cdp.eval(`document.querySelector('[data-nav="notes"]').click()`);
    await sleep(450);
    const notesEmpty = await cdp.eval(`(function(){
      var app = document.getElementById('app');
      return { len: app.innerHTML.length, hasEmpty: !!app.querySelector('.empty') };
    })()`);
    ok("笔记清空后渲染空状态", notesEmpty.hasEmpty && notesEmpty.len > 100,
      `len=${notesEmpty.len} hasEmpty=${notesEmpty.hasEmpty}`);

    /* 期间不应新增 JS 异常 */
    const newErrors = consoleErrors.slice(emptyStateErrorsBefore)
      .filter(e => !/favicon|404|Failed to load resource/i.test(e));
    ok("空状态视图未抛 JS 异常", newErrors.length === 0,
      newErrors.slice(0, 2).join(" | "));

    /* 从空状态也能返回首页并开始练习 */
    await cdp.eval(`document.querySelector('[data-nav="practice"]').click()`);
    await sleep(450);
    const practiceFromEmpty = await cdp.eval(`(function(){
      var btn = document.getElementById('pStart');
      if (!btn) return { ok: false, err: '无开始按钮' };
      btn.click();
      return { ok: true };
    })()`);
    await sleep(700);
    ok("空状态后仍可开始练习", practiceFromEmpty.ok && (await cdp.eval("!!document.querySelector('.q-stem')")),
      practiceFromEmpty.err || "");

    /* ============ 7. 登录流程（走真实 UI） ============ */
    console.log("\n【7】登录与同步");

    /*
     * 必须走真实登录界面，而不是直接调用 Api.register。
     * 直接调 API 只会设置 token，不会触发 Store.attachUser 与 UI 更新，
     * 测不出"登录后界面是否正确切换"这类问题。
     */
    const uname = "browser_" + Date.now().toString(36);

    /*
     * 注意：上面的空状态测试已清空全部笔记。
     * 这里重新写一条笔记，以便验证"笔记能否同步到服务端"。
     * （顺带验证了删除后再新建的路径。）
     */
    await cdp.eval(`(function(){
      var bank = window.QUESTION_BANK;
      window.Store.saveNote(bank[0].id, '登录前写的笔记：待同步');
      return true;
    })()`);
    await sleep(300);

    /* 打开登录页 */
    await cdp.eval(`document.querySelector('[data-nav="home"]').click()`);
    await sleep(400);
    const openedLogin = await cdp.eval(`(function(){
      var b = document.getElementById('loginBtn');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    ok("登录按钮可点击", openedLogin);
    await sleep(500);
    ok("登录页已打开", (await cdp.eval("!!document.getElementById('authForm')")));

    /* 切到注册标签并填写表单 */
    await cdp.eval(`(function(){
      var tab = document.querySelector('[data-auth-tab="register"]');
      if (tab) tab.click();
    })()`);
    await sleep(400);

    const filled = await cdp.eval(`(function(){
      function set(id, val) {
        var el = document.getElementById(id);
        if (!el) return false;
        el.value = val;
        el.dispatchEvent(new Event('input', {bubbles:true}));
        return true;
      }
      var a = set('authUsername', '${uname}');
      var b = set('authNickname', '浏览器测试');
      var c = set('authPassword', 'browser123456');
      var d = set('authPassword2', 'browser123456');
      return a && b && c && d;
    })()`);
    ok("注册表单可填写", filled);
    await sleep(200);

    /* 提交表单 */
    await cdp.eval(`(function(){
      var f = document.getElementById('authForm');
      if (f && typeof f.onsubmit === 'function') {
        f.onsubmit({ preventDefault: function(){} });
        return true;
      }
      var btn = document.getElementById('authSubmit');
      if (btn) { btn.click(); return true; }
      return false;
    })()`);
    await sleep(2500);

    /* 登录成功后应回到首页且顶栏显示用户 */
    const afterLogin = await cdp.eval(`(function(){
      var c = document.getElementById('userChip');
      var chip = document.getElementById('modeChip');
      return {
        loggedIn: !!(c && !c.classList.contains('hidden')),
        name: (c && !c.classList.contains('hidden')) ? document.getElementById('userName').textContent : '',
        mode: chip ? chip.textContent.trim() : '',
        onHome: document.body.innerText.indexOf('欢迎回来') >= 0,
        storeUser: window.Store.user ? window.Store.user.username : null
      };
    })()`);

    ok("登录后回到首页", afterLogin.onHome);
    ok("Store 记录了当前用户", afterLogin.storeUser === uname, `实际 ${afterLogin.storeUser}`);
    ok("顶栏显示当前用户", afterLogin.name === "浏览器测试", `实际「${afterLogin.name}」`);
    ok("数据模式标识为云端同步", afterLogin.mode === "云端同步", `实际「${afterLogin.mode}」`);

    /* 触发同步并确认服务端已收到数据 */
    await cdp.eval(`window.Store.syncNow()`);
    await sleep(1500);

    const serverProgress = await cdp.eval(`(async function(){
      try {
        var p = await window.Api.fetchProgress();
        return {
          records: Object.keys(p.records||{}).length,
          notes: Object.keys(p.notes||{}).length,
          review: Object.keys(p.review||{}).length
        };
      } catch(e) { return { err: e.message }; }
    })()`);
    ok("答题记录已同步到服务端", serverProgress.records > 0,
      `records=${serverProgress.records}`);
    ok("笔记已同步到服务端", serverProgress.notes > 0,
      `notes=${serverProgress.notes}`);
    ok("复习计划已同步到服务端", serverProgress.review > 0,
      `review=${serverProgress.review}`);

    /* 刷新页面后应自动恢复登录态并保留数据 */
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);
    const afterReload = await cdp.eval(`(function(){
      var c = document.getElementById('userChip');
      var loggedIn = !!(c && !c.classList.contains('hidden'));
      var d = {};
      try { d = JSON.parse(localStorage.getItem('xueer-quiz-v1') || '{}'); } catch(e){}
      return {
        loggedIn: loggedIn,
        name: loggedIn ? document.getElementById('userName').textContent : '',
        records: Object.keys(d.records||{}).length,
        notes: Object.keys(d.notes||{}).length,
        mode: document.getElementById('modeChip') ? document.getElementById('modeChip').textContent.trim() : ''
      };
    })()`);
    ok("刷新后自动恢复登录态", afterReload.loggedIn, `name=${afterReload.name}`);
    ok("刷新后用户显示正确", afterReload.name === "浏览器测试", `实际「${afterReload.name}」`);
    ok("刷新后答题记录仍在", afterReload.records > 0, `records=${afterReload.records}`);
    ok("刷新后笔记仍在", afterReload.notes > 0, `notes=${afterReload.notes}`);

    /* ============ 8. 控制台无异常 ============ */
    console.log("\n【8】运行时健康");
    const realErrors = consoleErrors.filter(e =>
      !/favicon|404|Failed to load resource/i.test(e));
    ok("无未捕获的 JS 异常", realErrors.length === 0,
      realErrors.slice(0, 3).join(" | "));

    /* 布局检查：关键元素未被遮挡/零尺寸 */
    const layoutOk = await cdp.eval(`(function(){
      var issues = [];
      var nav = document.getElementById('mainNav');
      if (!nav || nav.getBoundingClientRect().height < 10) issues.push('导航栏不可见');
      var app = document.getElementById('app');
      if (!app || app.getBoundingClientRect().width < 100) issues.push('主区域宽度异常');
      return issues;
    })()`);
    ok("关键布局正常", Array.isArray(layoutOk) && layoutOk.length === 0,
      (layoutOk || []).join(" | "));

  } catch (e) {
    fail++;
    problems.push("测试执行异常：" + e.message);
    console.log("\n✗ 执行异常：" + e.message);
  }

  /* ---------- 清理 ---------- */
  cdp.close();
  try { browserProc.kill(); } catch {}
  try { serverProc.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

  console.log("\n" + "=".repeat(66));
  console.log(`通过：${pass}    失败：${fail}`);
  if (problems.length) {
    console.log("\n✗ 问题：");
    problems.forEach(p => console.log("  - " + p));
  } else {
    console.log("\n✓ 真实浏览器中全部功能可用：渲染、答题、笔记、视图切换、登录同步均正常。");
  }
  console.log("=".repeat(66));
  process.exit(fail ? 1 : 0);
}

/* ============================================================
   降级：无 ws 模块时用 --dump-dom 做静态验证
   ============================================================ */
async function fallbackDomTest() {
  const browser = findBrowser();
  if (!browser) { console.log("无可用浏览器，跳过。"); return; }

  const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-dom-"));
  const serverProc = spawn(process.execPath, [
    path.join(ROOT, "server", "server.js"), "--port", String(PORT), "--no-open", "--quiet"
  ], {
    cwd: ROOT, env: { ...process.env, QUIZ_DATA_DIR: TEST_DATA }, stdio: "ignore"
  });

  for (let i = 0; i < 40; i++) {
    try {
      const r = await new Promise((res, rej) => {
        const q = http.get({ host: "127.0.0.1", port: PORT, path: "/api/meta", timeout: 1000 },
          (r2) => { r2.resume(); res(r2.statusCode); });
        q.on("error", rej); q.on("timeout", () => { q.destroy(); rej(new Error("t")); });
      });
      if (r === 200) break;
    } catch {}
    await sleep(250);
  }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "edge-fb-"));
  let dom = "";
  try {
    dom = execFileSync(browser, [
      "--headless=new", "--disable-gpu", "--no-first-run",
      `--user-data-dir=${profile}`, "--virtual-time-budget=8000",
      "--dump-dom", `http://127.0.0.1:${PORT}/`
    ], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 60000 });
  } catch (e) {
    dom = (e.stdout || "").toString();
  }

  console.log("\n【静态渲染验证】");
  ok("DOM 已渲染", dom.length > 2000, `${dom.length} 字符`);
  ok("欢迎语存在", dom.includes("欢迎回来"));
  ok("目标卡片存在", dom.includes("goal-card"));
  ok("学科卡片存在", dom.includes("subject-card"));
  ok("KaTeX 已渲染", dom.includes("katex"));
  ok("无 undefined 泄漏", !dom.includes("undefined"));

  serverProc.kill();
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

  console.log("\n" + "=".repeat(66));
  console.log(`通过：${pass}    失败：${fail}`);
  if (problems.length) problems.forEach(p => console.log("  - " + p));
  console.log("=".repeat(66));
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error("致命错误：", e.message);
  console.error((e.stack || "").split("\n").slice(1, 5).join("\n"));
  process.exit(1);
});
