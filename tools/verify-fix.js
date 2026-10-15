/**
 * 最终验收：用真实浏览器确认「没有题目」已修复
 * 注入导致故障的坏数据，验证页面仍能正常显示题目。
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8940;
const CDP_PORT = 9350;

function findBrowser() {
  for (const x of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  ]) { try { if (fs.existsSync(x)) return x; } catch {} }
  return null;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function get(port, p) {
  return new Promise((res) => {
    const q = http.get({ host: "127.0.0.1", port, path: p, timeout: 3000 }, (r) => {
      let s = ""; r.on("data", d => s += d); r.on("end", () => res({ status: r.statusCode, body: s }));
    });
    q.on("error", () => res({ status: 0 })); q.on("timeout", () => { q.destroy(); res({ status: 0 }); });
  });
}

async function main() {
  const browser = findBrowser();
  if (!browser) { console.log("无浏览器"); return; }

  const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "verify-"));
  const serverProc = spawn(process.execPath, [
    path.join(ROOT, "server", "server.js"), "--port", String(PORT), "--no-open", "--quiet"
  ], { cwd: ROOT, env: { ...process.env, QUIZ_DATA_DIR: TEST_DATA }, stdio: "ignore" });

  for (let i = 0; i < 40; i++) { if ((await get(PORT, "/api/meta")).status === 200) break; await sleep(250); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "verify-p-"));
  const bp = spawn(browser, [
    "--headless=new", "--disable-gpu", "--no-first-run",
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    "--window-size=1280,900", "about:blank"
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
  if (!wsUrl) { console.log("CDP 失败"); bp.kill(); serverProc.kill(); return; }

  const WebSocket = require("ws");
  const ws = new WebSocket(wsUrl, { maxPayload: 64 * 1024 * 1024 });
  await new Promise(r => ws.on("open", r));
  let id = 0; const pending = new Map(); const errors = [];
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id !== undefined && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
    else if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id; pending.set(i, { resolve });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
    return r.result.value;
  };

  await send("Runtime.enable");
  await send("Page.enable");

  console.log("=".repeat(70));
  console.log("最终验收：注入坏数据后题目是否仍可见");
  console.log("=".repeat(70));

  /* 先加载页面建立 origin */
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(2500);

  /* 注入导致原故障的坏数据 */
  const BAD = JSON.stringify({
    records: [], wrong: null, favorites: "x", daily: 123, streak: null, notes: null, exams: {}
  });
  await evalJs(`localStorage.setItem('xueer-quiz-v1', ${JSON.stringify(BAD)})`);
  console.log("\n已注入坏数据：records=[] wrong=null favorites=\"x\" daily=123 streak=null notes=null exams={}");

  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(3200);

  const st = await evalJs(`(function(){
    var app = document.getElementById('app');
    return {
      bankLen: (window.QUESTION_BANK || []).length,
      subjectCards: document.querySelectorAll('[data-start-subject]').length,
      appLen: app.innerHTML.length,
      hasWelcome: app.innerText.indexOf('欢迎回来') >= 0,
      hasSubjects: app.innerText.indexOf('按学科练习') >= 0,
      hasErrorPanel: !!document.getElementById('errReload'),
      hasBindError: !!document.getElementById('bindErrorBar')
    };
  })()`);

  console.log("\n【结果】");
  console.log("  题库:", st.bankLen, "题");
  console.log("  学科卡片:", st.subjectCards, "个");
  console.log("  首页 HTML:", st.appLen, "字符");
  console.log("  显示欢迎语:", st.hasWelcome ? "✓" : "✗");
  console.log("  显示「按学科练习」:", st.hasSubjects ? "✓" : "✗");
  console.log("  出现错误面板:", st.hasErrorPanel ? "是" : "否（正常）");
  console.log("  出现绑定错误条:", st.hasBindError ? "是" : "否（正常）");

  /* 实际进入答题 */
  await evalJs(`document.querySelector('[data-start-subject]').click()`);
  await sleep(1200);
  const quiz = await evalJs(`(function(){
    var stem = document.querySelector('.q-stem');
    return {
      onQuiz: !!stem,
      stem: stem ? stem.innerText.slice(0, 40).replace(/\\n+/g,' ') : '',
      opts: document.querySelectorAll('[data-opt]').length,
      sheet: document.querySelectorAll('.sheet-cell').length
    };
  })()`);

  console.log("\n【进入答题】");
  console.log("  成功进入:", quiz.onQuiz ? "✓" : "✗");
  if (quiz.onQuiz) {
    console.log("  题干:", quiz.stem);
    console.log("  选项:", quiz.opts, " 答题卡:", quiz.sheet);
  }

  console.log("\n【JS 异常】");
  const real = errors.filter(e => !/favicon|404/i.test(e));
  if (real.length) real.slice(0, 5).forEach(e => console.log("  ✗ " + String(e).split("\n")[0]));
  else console.log("  无");

  const fixed = st.bankLen === 100 && st.subjectCards === 12 && st.hasWelcome && quiz.onQuiz && real.length === 0;
  console.log("\n" + "=".repeat(70));
  console.log(fixed
    ? "✓ 验收通过：坏数据下题目仍完整可见，无异常。"
    : "✗ 验收失败：仍有问题。");
  console.log("=".repeat(70));

  ws.close(); bp.kill(); serverProc.kill();
  await sleep(400);
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(fixed ? 0 : 1);
}

main().catch(e => { console.error("异常:", e.message); process.exit(1); });
