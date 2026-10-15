/**
 * 自动截图工具
 *
 * 用途：为 README 生成界面截图。
 *
 * 设计要点：
 *  - 使用独立的临时数据目录与服务端口，不污染用户的真实数据
 *  - 先注入演示数据（答题记录、错题、笔记、目标进度），让界面有内容可看
 *  - 通过 CDP 的 Page.captureScreenshot 截取，用设备像素比提高清晰度
 *
 * 运行： node tools/screenshot.js
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT_DIR = path.join(ROOT, "docs", "screenshots");
const PORT = 8960;
const CDP_PORT = 9360;

/* 截图尺寸：1280 宽是 GitHub README 的常见显示宽度，2x 缩放保证清晰 */
const VIEWPORT = { width: 1280, height: 860 };
const SCALE = 2;

function findBrowser() {
  for (const p of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe"
  ]) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function httpGet(port, p) {
  return new Promise((res) => {
    const q = http.get({ host: "127.0.0.1", port, path: p, timeout: 3000 }, (r) => {
      let s = ""; r.on("data", d => s += d); r.on("end", () => res({ status: r.statusCode, body: s }));
    });
    q.on("error", () => res({ status: 0, body: "" }));
    q.on("timeout", () => { q.destroy(); res({ status: 0, body: "" }); });
  });
}

/* ============================================================
   CDP 客户端
   ============================================================ */
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.errors = []; }

  async connect() {
    const WebSocket = require("ws");
    this.ws = new WebSocket(this.url, { maxPayload: 128 * 1024 * 1024 });
    await new Promise((r, j) => { this.ws.on("open", r); this.ws.on("error", j); });
    this.ws.on("message", (data) => {
      let m; try { m = JSON.parse(data.toString()); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method === "Runtime.exceptionThrown") {
        this.errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }
      }, 30000);
    });
  }

  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error("页面 JS 异常: " + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  /** 截图并保存 */
  async shot(file, { fullPage = false } = {}) {
    const params = { format: "png", captureBeyondViewport: fullPage };
    const r = await this.send("Page.captureScreenshot", params);
    const buf = Buffer.from(r.data, "base64");
    fs.writeFileSync(file, buf);
    return buf.length;
  }

  close() { try { this.ws && this.ws.close(); } catch {} }
}

/* ============================================================
   演示数据：让界面看起来像真实使用过
   ============================================================ */
function buildDemoData(bank) {
  const now = Date.now();
  const DAY = 86400000;
  const dayKey = (ts) => {
    const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };

  /* 挑选有代表性的题目：含公式的高数题、英语题、数据结构题 */
  const pick = (ids) => ids.map(id => bank.find(q => q.id === id)).filter(Boolean);

  const records = {};
  const wrong = {};
  const favorites = {};
  const review = {};

  /* 造约 60 题的答题记录，正确率约 78% */
  const answered = bank.slice(0, 60);
  answered.forEach((q, i) => {
    const attempts = 1 + (i % 3 === 0 ? 1 : 0);
    const correct = i % 9 === 0 ? attempts - 1 : attempts;   // 少数题答错
    records[q.id] = {
      attempts,
      correct,
      wrong: attempts - correct,
      lastResult: attempts === correct ? "correct" : "wrong",
      lastAt: now - i * 3600000
    };
    if (attempts > correct) {
      wrong[q.id] = { addedAt: now - i * 3600000, count: 1, cleared: false };
    }
    /* 复习计划：一部分今天到期 */
    const stage = i % 5;
    review[q.id] = {
      stage,
      dueAt: i % 3 === 0 ? now - 3600000 : now + (stage + 1) * DAY,
      lastAt: now - DAY,
      ease: 2.5,
      lapses: 0
    };
  });

  /* 收藏几道题 */
  ["m-001", "m-011", "d-004", "e-002", "c-007"].forEach(id => {
    if (bank.some(q => q.id === id)) favorites[id] = { addedAt: now - 86400000 };
  });

  /* 笔记：写得像真实学生 */
  const notes = {
    "m-001": {
      text: "重要极限，考试必考！\n注意：sin x 与 x 是等价无穷小，比值极限为 1。\n记法：小角近似 sin x ≈ x",
      updatedAt: now - 7200000,
      createdAt: now - 86400000
    },
    "m-011": {
      text: "容易错在定义域！\n1/x 的积分是 ln|x| + C，不是 ln x + C。\n因为 x 可能是负数。",
      updatedAt: now - 3600000,
      createdAt: now - 43200000
    },
    "d-004": {
      text: "二叉搜索树中序遍历 = 递增序列，这个性质常考。\n反推：给一个序列判断能否构成 BST。",
      updatedAt: now - 1800000,
      createdAt: now - 21600000
    }
  };

  /* 近 14 天答题量：有起伏，看起来真实 */
  const daily = {};
  const pattern = [18, 22, 0, 25, 30, 12, 20, 28, 0, 15, 24, 32, 20, 16];
  for (let i = 13; i >= 0; i--) {
    const ts = now - i * DAY;
    const n = pattern[13 - i];
    daily[dayKey(ts)] = { answered: n, correct: Math.round(n * 0.78) };
  }

  /* 考试记录 */
  const exams = [
    {
      id: "e-demo-1", at: now - 2 * DAY, subject: "高等数学 · 模拟考",
      total: 20, right: 17, score: 85, durationSec: 1080,
      detail: []
    },
    {
      id: "e-demo-2", at: now - 5 * DAY, subject: "综合卷 · 模拟考",
      total: 20, right: 14, score: 70, durationSec: 1440,
      detail: []
    },
    {
      id: "e-demo-3", at: now - 9 * DAY, subject: "数据结构 · 模拟考",
      total: 10, right: 9, score: 90, durationSec: 600,
      detail: []
    }
  ];

  return {
    records, wrong, favorites, review, notes, daily, exams,
    streak: { days: 7, lastDate: dayKey(now) },
    goals: { dailyQuestions: 20, dailyMinutes: 0, updatedAt: now },
    settings: { theme: "light", instantJudge: true, autoNext: false, fontSize: "md" }
  };
}

/* ============================================================
   主流程
   ============================================================ */
async function main() {
  console.log("=".repeat(66));
  console.log("自动截图");
  console.log("=".repeat(66));

  const browser = findBrowser();
  if (!browser) { console.log("✗ 未找到浏览器"); process.exit(1); }
  console.log(`\n浏览器：${browser}`);

  /* 准备输出目录 */
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`输出目录：${OUT_DIR}`);

  /* 用独立数据目录启动服务 */
  const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-shot-"));
  const serverProc = spawn(process.execPath, [
    path.join(ROOT, "server", "server.js"), "--port", String(PORT), "--no-open", "--quiet"
  ], {
    cwd: ROOT,
    env: { ...process.env, QUIZ_DATA_DIR: TEST_DATA, QUIZ_RL_REGISTER: "100" },
    stdio: "ignore"
  });

  let up = false;
  for (let i = 0; i < 40; i++) {
    if ((await httpGet(PORT, "/api/meta")).status === 200) { up = true; break; }
    await sleep(250);
  }
  if (!up) { console.log("✗ 服务启动失败"); serverProc.kill(); process.exit(1); }
  console.log(`服务：http://127.0.0.1:${PORT}\n`);

  /* 启动浏览器 */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "shot-prof-"));
  const bp = spawn(browser, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--hide-scrollbars",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
    "about:blank"
  ], { stdio: "ignore" });

  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await new Promise((res, rej) => {
        const q = http.get({ host: "127.0.0.1", port: CDP_PORT, path: "/json/list", timeout: 1000 }, (r) => {
          let s = ""; r.on("data", c => s += c); r.on("end", () => res(JSON.parse(s)));
        });
        q.on("error", rej); q.on("timeout", () => { q.destroy(); rej(new Error("t")); });
      });
      const pg = list.find(t => t.type === "page");
      if (pg && pg.webSocketDebuggerUrl) { wsUrl = pg.webSocketDebuggerUrl; break; }
    } catch {}
    await sleep(300);
  }
  if (!wsUrl) { console.log("✗ CDP 连接失败"); bp.kill(); serverProc.kill(); process.exit(1); }

  const cdp = new CDP(wsUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: VIEWPORT.width, height: VIEWPORT.height,
    deviceScaleFactor: SCALE, mobile: false
  });

  const results = [];

  try {
    /* 载入页面 */
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    /* 注入演示数据并刷新 */
    console.log("注入演示数据...");
    /*
     * 用 vm 加载题库，而不是用正则从源码里抠 JSON ——
     * questions.js 是 JS 源码（含注释、LaTeX 转义），正则提取很脆弱。
     */
    const vm = require("vm");
    const bankSandbox = { window: {} };
    vm.createContext(bankSandbox);
    vm.runInContext(
      fs.readFileSync(path.join(ROOT, "js", "questions.js"), "utf8"),
      bankSandbox, { filename: "questions.js" }
    );
    const bankFull = bankSandbox.window.QUESTION_BANK;
    const demo = buildDemoData(bankFull);

    await cdp.eval(`localStorage.setItem('xueer-quiz-v1', ${JSON.stringify(JSON.stringify(demo))})`);
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
    await sleep(3500);

    /* 确认数据已生效 */
    const stats = await cdp.eval(`(function(){
      var d = JSON.parse(localStorage.getItem('xueer-quiz-v1') || '{}');
      return {
        records: Object.keys(d.records||{}).length,
        wrong: Object.keys(d.wrong||{}).length,
        notes: Object.keys(d.notes||{}).length,
        exams: (d.exams||[]).length,
        daily: Object.keys(d.daily||{}).length
      };
    })()`);
    console.log(`  答题记录 ${stats.records} · 错题 ${stats.wrong} · 笔记 ${stats.notes} · 考试 ${stats.exams} · 天数 ${stats.daily}`);

    /* ---------- 1. 首页 ---------- */
    console.log("\n截图中...");
    await cdp.eval(`document.querySelector('[data-nav="home"]').click()`);
    await sleep(1200);
    let size = await cdp.shot(path.join(OUT_DIR, "01-home.png"));
    results.push(["01-home.png", "首页（目标进度 + 学科卡片）", size]);
    console.log(`  ✓ 首页  ${(size / 1024).toFixed(0)} KB`);

    /* ---------- 2. 答题页（含公式） ---------- */
    /* 进入高数练习，定位到含 LaTeX 公式的第一题 */
    await cdp.eval(`(function(){
      var b = document.querySelector('[data-start-subject]');
      if (b) b.click();
    })()`);
    await sleep(1500);
    /* 跳到 m-001（重要极限，含公式） */
    const jumped = await cdp.eval(`(function(){
      var cells = document.querySelectorAll('.sheet-cell');
      for (var i = 0; i < cells.length; i++) {
        cells[i].click();
        var stem = document.querySelector('.q-stem');
        if (stem && stem.querySelector('.katex')) return i;
      }
      return -1;
    })()`);
    await sleep(1200);
    /* 点一个选项，让解析显示出来（截图更丰富） */
    await cdp.eval(`(function(){
      var opts = document.querySelectorAll('[data-opt]');
      if (opts.length > 1) opts[1].click();
    })()`);
    await sleep(1200);
    size = await cdp.shot(path.join(OUT_DIR, "02-quiz.png"));
    results.push(["02-quiz.png", "答题页（数学公式 + 解析 + 笔记）", size]);
    console.log(`  ✓ 答题页  ${(size / 1024).toFixed(0)} KB  (公式题索引 ${jumped})`);

    /* ---------- 3. 知识点热力图 ---------- */
    await cdp.eval(`document.querySelector('[data-nav="knowledge"]').click()`);
    await sleep(1500);
    size = await cdp.shot(path.join(OUT_DIR, "03-knowledge.png"));
    results.push(["03-knowledge.png", "知识点掌握度热力图", size]);
    console.log(`  ✓ 知识点  ${(size / 1024).toFixed(0)} KB`);

    /* ---------- 4. 学习统计 ---------- */
    await cdp.eval(`document.querySelector('[data-nav="stats"]').click()`);
    await sleep(1500);
    size = await cdp.shot(path.join(OUT_DIR, "04-stats.png"));
    results.push(["04-stats.png", "学习统计（柱状图 + 学科掌握度）", size]);
    console.log(`  ✓ 统计  ${(size / 1024).toFixed(0)} KB`);

    /* ---------- 5. 今日复习 ---------- */
    await cdp.eval(`document.querySelector('[data-nav="review"]').click()`);
    await sleep(1500);
    size = await cdp.shot(path.join(OUT_DIR, "05-review.png"));
    results.push(["05-review.png", "今日复习（间隔重复计划）", size]);
    console.log(`  ✓ 复习  ${(size / 1024).toFixed(0)} KB`);

    /* ---------- 6. 模拟考成绩单 ---------- */
    /*
     * 注意：confirm() 对话框会阻塞 CDP（Runtime.evaluate 无法返回），
     * 因此交卷前先覆写 window.confirm 为立即返回 true。
     */
    await cdp.eval(`document.querySelector('[data-nav="home"]').click()`);
    await sleep(1000);
    await cdp.eval(`window.confirm = function(){ return true; }; 1`);
    await cdp.eval(`document.querySelector('[data-nav="exam"]').click()`);
    await sleep(1200);
    await cdp.eval(`document.getElementById('eCount').value = '10'`);
    await cdp.eval(`document.getElementById('eTime').value = '10'`);
    await cdp.eval(`document.getElementById('eStart').click()`);
    await sleep(1800);
    /* 答完 10 题（点第一个选项） */
    await cdp.eval(`(function(){
      for (var i = 0; i < 10; i++) {
        var opts = document.querySelectorAll('[data-opt]');
        if (opts.length) opts[0].click();
        var next = document.getElementById('btnNext');
        if (next && i < 9) next.click();
      }
    })()`);
    await sleep(1200);
    /* 交卷（confirm 已被覆写，不会阻塞） */
    await cdp.eval(`(function(){
      var s = document.getElementById('btnSubmit');
      if (s) s.click();
    })()`);
    await sleep(2500);
    size = await cdp.shot(path.join(OUT_DIR, "06-exam-result.png"));
    results.push(["06-exam-result.png", "模拟考成绩单", size]);
    console.log(`  ✓ 成绩单  ${(size / 1024).toFixed(0)} KB`);

    /* ---------- 7. 深色模式首页 ---------- */
    await cdp.eval(`document.querySelector('[data-nav="home"]').click()`);
    await sleep(1000);
    await cdp.eval(`document.getElementById('themeToggle').click()`);
    await sleep(1200);
    size = await cdp.shot(path.join(OUT_DIR, "07-dark.png"));
    results.push(["07-dark.png", "深色模式", size]);
    console.log(`  ✓ 深色模式  ${(size / 1024).toFixed(0)} KB`);

  } catch (e) {
    console.log("\n✗ 截图过程出错: " + e.message);
  }

  /* 报告 */
  console.log("\n" + "=".repeat(66));
  console.log("截图结果");
  console.log("=".repeat(66));
  let total = 0;
  for (const [file, desc, size] of results) {
    total += size;
    console.log(`  ${file.padEnd(22)} ${(size / 1024).toFixed(0).padStart(5)} KB   ${desc}`);
  }
  console.log(`\n  共 ${results.length} 张，合计 ${(total / 1024 / 1024).toFixed(2)} MB`);

  if (cdp.errors.length) {
    console.log(`\n  ⚠ 页面异常 ${cdp.errors.length} 条：`);
    cdp.errors.slice(0, 3).forEach(e => console.log("    " + String(e).split("\n")[0]));
  }

  /* 清理 */
  cdp.close();
  try { bp.kill(); } catch {}
  try { serverProc.kill(); } catch {}
  await sleep(500);
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}

  console.log("\n完成。");
}

main().catch(e => {
  console.error("致命错误：", e.message);
  console.error((e.stack || "").split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
