/**
 * 一键启动与启动器测试
 *
 * 验证内容：
 *   1. 启动器文件存在，且为 ASCII + CRLF（cmd.exe 的硬性要求）
 *   2. 不含 "for %%p in (...)" 陷阱（%ProgramFiles(x86)% 的右括号会破坏块解析）
 *   3. 含 chcp 65001（否则中文输出在 GBK 控制台乱码）
 *   4. 服务端 --port / --no-open 参数解析正确
 *   5. 端口被占用时自动顺延
 *   6. 启动后 API 真实可用
 *
 * 运行： node test/launcher.test.js
 */
const fs = require("fs");
const path = require("path");
const http = require("http");
const os = require("os");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const LAUNCHER = path.join(ROOT, "启动刷题系统.cmd");

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); }
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 发起一个 GET，返回 {status, body} */
function get(port, p) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path: p, timeout: 3000 }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        let body = null;
        try { body = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body, raw });
      });
    });
    req.on("error", () => resolve({ status: 0, body: null }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end();
  });
}

/** 等待端口就绪，最多 waitMs 毫秒 */
async function waitForPort(port, waitMs = 12000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const r = await get(port, "/api/meta");
    if (r.status === 200) return true;
    await sleep(300);
  }
  return false;
}

async function main() {
  console.log("=".repeat(64));
  console.log("一键启动与启动器测试");
  console.log("=".repeat(64));

  /* ============================================================
     一、启动器文件静态检查
     ============================================================ */
  console.log("\n【一】启动器文件检查");

  ok("启动器文件存在", fs.existsSync(LAUNCHER), LAUNCHER);
  if (!fs.existsSync(LAUNCHER)) return;

  const buf = fs.readFileSync(LAUNCHER);
  const text = buf.toString("utf8");

  /* ASCII-only：cmd 按 OEM 代码页解析批处理，非 ASCII 会被误解码 */
  const nonAscii = [...buf].filter(b => b > 127).length;
  ok("启动器为纯 ASCII（避免 OEM 代码页误解码）", nonAscii === 0,
    `发现 ${nonAscii} 个非 ASCII 字节`);
  console.log(`  文件大小：${buf.length} B，非 ASCII 字节：${nonAscii}`);

  /* CRLF：批处理需要 CRLF，纯 LF 会导致解析错误 */
  let crlf = 0, loneLf = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 10) {
      if (i > 0 && buf[i - 1] === 13) crlf++;
      else loneLf++;
    }
  }
  ok("启动器使用 CRLF 行尾", loneLf === 0, `发现 ${loneLf} 个孤立 LF`);
  console.log(`  CRLF 行数：${crlf}`);

  /* chcp 65001：否则 Node 的 UTF-8 中文输出在 936 控制台乱码 */
  ok("启动器切换控制台为 UTF-8（chcp 65001）", /chcp\s+65001/i.test(text));

  /* 关键陷阱：%ProgramFiles(x86)% 的 ")" 会提前关闭 for(...) 块 */
  const forParenTrap = /for\s+%%[a-z]\s+in\s*\([^)]*%ProgramFiles\(x86\)%/i.test(text);
  ok("不含 %ProgramFiles(x86)% 的 for(...) 解析陷阱", !forParenTrap,
    "含该写法会导致批处理语法错误");

  /* 必须能定位 Node：PATH + 常见位置 + 内置运行时 */
  ok("启动器会在 PATH 中查找 node", /where\s+node/i.test(text));
  ok("启动器会查找常见 Node 安装位置", /nodejs\\node\.exe/i.test(text));
  ok("启动器会查找内置运行时（DSH 自带 Node）",
    /dsh-runtimes|DeepSeek Harness\\resources\\runtime/i.test(text));

  /* 找不到 Node 时应有降级出口，而不是死路 */
  ok("缺少 Node 时提供本地模式出口", /index\.html/i.test(text));

  /* ============================================================
     二、服务端参数解析
     ============================================================ */
  console.log("\n【二】服务端参数解析");

  const serverSrc = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  ok("支持 --port 参数", /--port/.test(serverSrc));
  ok("支持 --no-open 参数", /--no-open/.test(serverSrc));
  ok("实现了端口顺延重试", /EADDRINUSE/.test(serverSrc) && /PORT_TRIES/.test(serverSrc));
  ok("实现了自动打开浏览器", /openBrowser/.test(serverSrc));
  ok("Windows 用 cmd start 打开浏览器", /"cmd"/.test(serverSrc) && /start/.test(serverSrc));
  ok("导出 openBrowser 便于测试", /module\.exports[\s\S]*openBrowser/.test(serverSrc));

  /* ============================================================
     三、端口顺延（真实运行）
     ============================================================ */
  console.log("\n【三】端口顺延");

  const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-launch-"));
  const BASE_PORT = 8850;

  /* 先占用 BASE_PORT */
  const blocker = http.createServer((q, s) => s.end("busy"));
  await new Promise(r => blocker.listen(BASE_PORT, r));
  console.log(`  已占用端口 ${BASE_PORT}`);

  /* 启动服务，指定被占用的端口 */
  const child = spawn(process.execPath, [
    path.join(ROOT, "server", "server.js"),
    "--port", String(BASE_PORT),
    "--no-open"
  ], {
    cwd: ROOT,
    env: { ...process.env, QUIZ_DATA_DIR: TEST_DATA },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  child.stdout.on("data", d => { stdout += d.toString(); });

  const okAtNext = await waitForPort(BASE_PORT + 1);
  ok(`端口被占用时自动顺延到 ${BASE_PORT + 1}`, okAtNext);

  if (okAtNext) {
    const meta = await get(BASE_PORT + 1, "/api/meta");
    ok("顺延后的服务 API 正常", meta.status === 200 && meta.body.total > 0,
      `status=${meta.status}`);
    console.log(`  题库：${meta.body ? meta.body.total : "?"} 题`);

    const page = await get(BASE_PORT + 1, "/");
    ok("顺延后首页可访问", page.status === 200 && /<html/i.test(page.raw));
  }

  /* 清理 */
  child.kill();
  await new Promise(r => blocker.close(r));
  await sleep(300);
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}

  /* ============================================================
     四、正常启动（不被占用）
     ============================================================ */
  console.log("\n【四】正常启动");

  const TEST_DATA2 = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-launch2-"));
  const P2 = 8860;

  const child2 = spawn(process.execPath, [
    path.join(ROOT, "server", "server.js"),
    "--port", String(P2),
    "--no-open"
  ], {
    cwd: ROOT,
    env: { ...process.env, QUIZ_DATA_DIR: TEST_DATA2 },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let out2 = "";
  child2.stdout.on("data", d => { out2 += d.toString(); });

  const up = await waitForPort(P2);
  ok("服务正常启动", up);

  if (up) {
    /* 启动横幅应包含网址与中文说明 */
    await sleep(200);
    const hasUrl = out2.includes(`localhost:${P2}`);
    ok("启动横幅显示正确网址", hasUrl, hasUrl ? "" : out2.slice(0, 120));

    const hasChinese = /学而刷题|网址|题库/.test(out2);
    ok("启动横幅含中文提示（chcp 后可见）", hasChinese);

    /* 前端关键资源可访问 */
    for (const [p, name] of [
      ["/js/merge.js", "合并模块"],
      ["/js/render.js", "渲染模块"],
      ["/vendor/katex/katex.min.js", "KaTeX"]
    ]) {
      const r = await get(P2, p);
      ok(`${name}可访问`, r.status === 200, `status=${r.status}`);
    }

    /* 安全边界仍然有效 */
    const blocked = await get(P2, "/server/db.js");
    ok("后端源码仍被拦截", blocked.status === 403, `status=${blocked.status}`);
  }

  child2.kill();
  await sleep(300);
  try { fs.rmSync(TEST_DATA2, { recursive: true, force: true }); } catch {}

  /* ============================================================
     报告
     ============================================================ */
  console.log("\n" + "=".repeat(64));
  console.log(`通过：${pass}    失败：${fail}`);
  if (problems.length) {
    console.log("\n✗ 问题：");
    problems.forEach(p => console.log("  - " + p));
  } else {
    console.log("\n✓ 一键启动可用：启动器健壮，端口顺延与自动开浏览器逻辑正确。");
  }
  console.log("=".repeat(64));
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error("\n测试异常：", e.message);
  console.error((e.stack || "").split("\n").slice(1, 4).join("\n"));
  process.exit(1);
});
