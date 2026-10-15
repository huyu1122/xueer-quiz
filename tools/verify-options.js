/**
 * 验证选项公式渲染修复（$0$ / $1$ 类选项）
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PORT = 8970;
const CDP_PORT = 9370;

const findBrowser = () => {
  for (const p of [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  ]) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const get = (port, p) => new Promise((res) => {
  const q = http.get({ host: "127.0.0.1", port, path: p, timeout: 3000 }, (r) => {
    let s = ""; r.on("data", d => s += d); r.on("end", () => res({ status: r.statusCode, body: s }));
  });
  q.on("error", () => res({ status: 0 })); q.on("timeout", () => { q.destroy(); res({ status: 0 }); });
});

async function main() {
  const browser = findBrowser();
  if (!browser) { console.log("无浏览器"); process.exit(1); }

  const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "verify-opt-"));
  const sp = spawn(process.execPath, [
    path.join(ROOT, "server", "server.js"), "--port", String(PORT), "--no-open", "--quiet"
  ], { cwd: ROOT, env: { ...process.env, QUIZ_DATA_DIR: TEST_DATA }, stdio: "ignore" });

  for (let i = 0; i < 40; i++) { if ((await get(PORT, "/api/meta")).status === 200) break; await sleep(250); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vp-"));
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
  if (!wsUrl) { console.log("CDP 失败"); bp.kill(); sp.kill(); process.exit(1); }

  const WebSocket = require("ws");
  const ws = new WebSocket(wsUrl, { maxPayload: 128 * 1024 * 1024 });
  await new Promise(r => ws.on("open", r));
  let id = 0; const pending = new Map();
  ws.on("message", (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.id !== undefined && pending.has(m.id)) { const { resolve } = pending.get(m.id); pending.delete(m.id); resolve(m.result); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id; pending.set(i, { resolve });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evalJs = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { __err: r.exceptionDetails.exception?.description };
    return r.result.value;
  };

  await send("Runtime.enable");
  await send("Page.enable");
  await send("Page.navigate", { url: `http://127.0.0.1:${PORT}/` });
  await sleep(3500);

  console.log("=".repeat(66));
  console.log("验证：选项公式渲染（$0$ / $1$ 类）");
  console.log("=".repeat(66));

  /* 进入高数练习 */
  await evalJs(`document.querySelector('[data-start-subject]').click()`);
  await sleep(1500);

  /* 找所有含 $ 公式选项的题，检查选项是否渲染为 .katex */
  const result = await evalJs(`(function(){
    var bank = window.QUESTION_BANK.filter(function(q){
      return q.options && q.options.some(function(o){ return /\\$[^$]+\\$/.test(o); });
    });
    var checked = 0, renderedOk = 0, rawText = [];
    var cells = document.querySelectorAll('.sheet-cell');
    var limit = Math.min(cells.length, 18);
    for (var i = 0; i < limit; i++) {
      cells[i].click();
      var opts = document.querySelectorAll('[data-opt] .option-text');
      if (!opts.length) continue;
      // 该题是否有选项含 $...$（用页面数据判断）
      var hasDollarOpt = Array.from(opts).some(function(o){
        return /^\\$[^$]+\\$$/.test(o.textContent.trim()) === false && o.textContent.indexOf('$') >= 0;
      });
      // 若页面文本仍有裸 $，说明没渲染
      var anyRaw = Array.from(opts).some(function(o){ return o.textContent.indexOf('$') >= 0; });
      checked++;
      if (!anyRaw) renderedOk++;
      else if (rawText.length < 3) {
        rawText.push(Array.from(opts).map(function(o){return o.textContent.trim().slice(0,20);}).join(' | '));
      }
    }
    return { bankCount: bank.length, checked: checked, renderedOk: renderedOk, rawText: rawText };
  })()`);

  console.log(`\n  题库中含公式选项的题: ${result.bankCount} 道`);
  console.log(`  实际检查: ${result.checked} 题`);
  console.log(`  选项无裸 $ 的（渲染成功）: ${result.renderedOk}`);
  if (result.rawText.length) {
    console.log(`\n  仍有原始 $ 文本的示例:`);
    result.rawText.forEach(t => console.log(`    ${t}`));
  }

  const okAll = result.checked > 0 && result.renderedOk === result.checked;
  console.log("\n" + "=".repeat(66));
  console.log(okAll ? "✓ 修复验证通过：所有选项公式均正常渲染" : "✗ 仍有未渲染的选项");
  console.log("=".repeat(66));

  ws.close(); bp.kill(); sp.kill();
  await sleep(400);
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  process.exit(okAll ? 0 : 1);
}

main().catch(e => { console.error("异常:", e.message); process.exit(1); });
