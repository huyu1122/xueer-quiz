/**
 * 性能与资源限制回归测试
 *
 * 固化本轮优化的关键行为，防止后续改动退化：
 *   1. 响应压缩（gzip / brotli）与协商缓存（ETag / 304）
 *   2. 事件循环不被密码哈希阻塞
 *   3. 数据裁剪：daily / notes 条数与总字节都有上界
 *   4. 请求体超限返回 413（而非断开连接）
 *   5. 注册接口限流
 *
 * 运行： node test/perf.test.js
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-perf-test-"));
process.env.QUIZ_DATA_DIR = TEST_DATA;
process.env.PORT = "8899";
const PORT = 8899;

const ROOT = path.join(__dirname, "..");
const { server, BODY_LIMIT } = require("../server/server");
const Compress = require(path.join(ROOT, "server", "compress.js"));
const RL = require(path.join(ROOT, "server", "ratelimit.js"));
const M = require(path.join(ROOT, "js", "merge.js"));

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); }
};

function req(method, p, { body, token, headers: extra } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { ...(extra || {}) };
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (token) headers["authorization"] = "Bearer " + token;

    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch {}
        resolve({ status: res.statusCode, body: json, raw, headers: res.headers });
      });
    });
    // 服务端可能在写完前返回 413，忽略写错误（浏览器同样如此）
    r.on("error", (e) => {
      if (e.code === "EPIPE" || e.code === "ECONNRESET") return;
      reject(e);
    });
    if (payload) { try { r.write(payload); } catch {} }
    r.end();
  });
}

async function main() {
  console.log("=".repeat(66));
  console.log("性能与资源限制回归测试");
  console.log("=".repeat(66));

  /* ============================================================
     一、压缩工具单元测试
     ============================================================ */
  console.log("\n【一】压缩工具");

  ok("text/css 判定为可压缩", Compress.isCompressible("text/css; charset=utf-8"));
  ok("application/json 判定为可压缩", Compress.isCompressible("application/json; charset=utf-8"));
  ok("application/javascript 判定为可压缩", Compress.isCompressible("application/javascript"));
  ok("image/png 判定为不可压缩", !Compress.isCompressible("image/png"));
  ok("字体判定为不可压缩", !Compress.isCompressible("font/woff2"));
  ok("空类型判定为不可压缩", !Compress.isCompressible(""));

  ok("优先选择 brotli", Compress.pickEncoding("gzip, deflate, br") === "br");
  ok("无 br 时选 gzip", Compress.pickEncoding("gzip, deflate") === "gzip");
  ok("仅 deflate 时选 deflate", Compress.pickEncoding("deflate") === "deflate");
  ok("q=0 表示拒绝", Compress.pickEncoding("gzip, deflate, br;q=0") === "gzip");
  ok("空头返回 null", Compress.pickEncoding("") === null);
  ok("无头返回 null", Compress.pickEncoding(undefined) === null);

  {
    const buf = Buffer.from("x".repeat(5000));
    ok("gzip 确实压缩", Compress.compress(buf, "gzip").length < buf.length);
    ok("brotli 确实压缩", Compress.compress(buf, "br").length < buf.length);
    ok("deflate 确实压缩", Compress.compress(buf, "deflate").length < buf.length);
    ok("brotli 优于 gzip", Compress.compress(buf, "br").length <= Compress.compress(buf, "gzip").length);
  }

  /* ============================================================
     二、响应压缩与缓存（真实 HTTP）
     ============================================================ */
  console.log("\n【二】响应压缩与缓存");

  {
    const plain = await req("GET", "/api/questions", { headers: { "accept-encoding": "identity" } });
    const comp = await req("GET", "/api/questions", { headers: { "accept-encoding": "gzip, deflate, br" } });

    ok("题库接口可用", plain.status === 200 && comp.status === 200);
    ok("声明不接受压缩时不压缩", !plain.headers["content-encoding"],
      `实际 ${plain.headers["content-encoding"]}`);
    ok("接受压缩时返回压缩内容", !!comp.headers["content-encoding"],
      `content-encoding=${comp.headers["content-encoding"]}`);
    ok("压缩后体积显著减小", comp.raw.length < plain.raw.length * 0.6,
      `${plain.raw.length} → ${comp.raw.length}`);
    ok("声明 Vary: Accept-Encoding", /accept-encoding/i.test(comp.headers["vary"] || ""));

    /* 解压后应与未压缩内容一致 */
    const enc = comp.headers["content-encoding"];
    const decompressed = enc === "br" ? zlib.brotliDecompressSync(comp.raw)
      : enc === "gzip" ? zlib.gunzipSync(comp.raw)
      : zlib.inflateSync(comp.raw);
    ok("解压后内容与原文一致", decompressed.toString("utf8") === plain.raw.toString("utf8"));
  }

  {
    /* 静态资源应有 ETag 与协商缓存 */
    const first = await req("GET", "/css/style.css");
    ok("静态资源返回 ETag", !!first.headers["etag"], `etag=${first.headers["etag"]}`);
    ok("静态资源返回 Last-Modified", !!first.headers["last-modified"]);

    const second = await req("GET", "/css/style.css", {
      headers: { "if-none-match": first.headers["etag"] }
    });
    ok("带 If-None-Match 返回 304", second.status === 304, `实际 ${second.status}`);
    ok("304 响应体为空", second.raw.length === 0, `实际 ${second.raw.length} 字节`);

    const ims = await req("GET", "/css/style.css", {
      headers: { "if-modified-since": first.headers["last-modified"] }
    });
    ok("带 If-Modified-Since 返回 304", ims.status === 304, `实际 ${ims.status}`);

    /* 错误的 ETag 不应命中 */
    const wrong = await req("GET", "/css/style.css", { headers: { "if-none-match": '"bogus"' } });
    ok("错误 ETag 返回完整内容", wrong.status === 200 && wrong.raw.length > 0);

    /* 压缩后的静态资源 */
    const compCss = await req("GET", "/css/style.css", {
      headers: { "accept-encoding": "gzip, deflate, br" }
    });
    ok("静态资源支持压缩", !!compCss.headers["content-encoding"]);
    ok("静态资源压缩后更小", compCss.raw.length < first.raw.length);
  }

  /* ============================================================
     三、事件循环不被阻塞
     ============================================================ */
  console.log("\n【三】事件循环响应性");

  {
    /* 单次 scrypt 的耗时基线 */
    const crypto = require("crypto");
    const salt = crypto.randomBytes(16).toString("hex");
    const t0 = process.hrtime.bigint();
    crypto.scryptSync("bench", salt, 64);
    const oneHashMs = Number(process.hrtime.bigint() - t0) / 1e6;

    /* 并发触发哈希，同时探测轻量请求的延迟 */
    const N = 8;
    const jobs = Array.from({ length: N }, (_, i) =>
      req("POST", "/api/register", {
        body: { username: `el_${Date.now().toString(36)}_${i}`, password: "el123456" }
      })
    );

    const probeStart = process.hrtime.bigint();
    const probe = await req("GET", "/api/meta");
    const probeMs = Number(process.hrtime.bigint() - probeStart) / 1e6;

    const results = await Promise.all(jobs);
    ok("并发注册全部成功", results.every(r => r.status === 200),
      `状态：${results.map(r => r.status).join(",")}`);

    /*
     * 关键断言：轻量请求不应被哈希阻塞。
     * 若用 scryptSync，探测请求会排在哈希之后，延迟接近 oneHashMs。
     */
    ok("轻量请求未被密码哈希阻塞", probeMs < oneHashMs * 0.8,
      `探测 ${probeMs.toFixed(1)}ms vs 单次哈希 ${oneHashMs.toFixed(1)}ms`);
    console.log(`  单次哈希 ${oneHashMs.toFixed(1)}ms，探测请求 ${probeMs.toFixed(1)}ms`);
  }

  /* ============================================================
     四、数据裁剪
     ============================================================ */
  console.log("\n【四】数据裁剪");

  {
    /* daily 超限裁剪 */
    const p = M.emptyProgress();
    for (let i = 0; i < 600; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const pad = (n) => String(n).padStart(2, "0");
      p.daily[`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`] = { answered: 1, correct: 1 };
    }
    const pruned = M.pruneProgress(p);
    ok("daily 裁剪到上限", Object.keys(pruned.daily).length === M.DAILY_KEEP_DAYS,
      `实际 ${Object.keys(pruned.daily).length}`);
    ok("daily 保留的是最近日期", Object.keys(pruned.daily).includes(M.dayKey()),
      "应保留今天");
    ok("daily 裁剪掉最旧日期", !Object.keys(pruned.daily).includes(
      (() => { const d = new Date(); d.setDate(d.getDate() - 500); const pad = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; })()
    ));
  }

  {
    /* notes 条数裁剪 */
    const p = M.emptyProgress();
    for (let i = 0; i < 6000; i++) p.notes[`n${i}`] = { text: "x", updatedAt: i, createdAt: i };
    const pruned = M.pruneProgress(p);
    ok("notes 裁剪到条数上限", Object.keys(pruned.notes).length <= M.MAX_NOTES,
      `实际 ${Object.keys(pruned.notes).length}`);
    ok("notes 保留的是最近更新", Object.keys(pruned.notes).includes("n5999"));
  }

  {
    /* notes 总字节裁剪 —— 保证 payload 有确定上界 */
    const p = M.emptyProgress();
    for (let i = 0; i < 3000; i++) {
      p.notes[`big${i}`] = { text: "长".repeat(1000), updatedAt: i, createdAt: i };
    }
    const pruned = M.pruneProgress(p);
    let bytes = 0;
    for (const k in pruned.notes) bytes += pruned.notes[k].text.length * 3 + 48;
    ok("notes 总字节受上限约束", bytes <= M.MAX_NOTES_BYTES * 1.2,
      `${(bytes / 1024 / 1024).toFixed(2)} MB vs 上限 ${(M.MAX_NOTES_BYTES / 1024 / 1024).toFixed(2)} MB`);
    ok("字节裁剪仍保留最新笔记", Object.keys(pruned.notes).includes("big2999"));
  }

  {
    /* 裁剪是确定性的，不能破坏合并的交换律 */
    const a = M.emptyProgress();
    for (let i = 0; i < 500; i++) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const pad = (n) => String(n).padStart(2, "0");
      a.daily[`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`] = { answered: 1, correct: 1 };
    }
    const b = M.emptyProgress();
    b.daily[M.dayKey()] = { answered: 5, correct: 5 };
    const ab = JSON.stringify(M.mergeProgress(a, b));
    const ba = JSON.stringify(M.mergeProgress(b, a));
    ok("裁剪后合并仍满足交换律", ab === ba);
  }

  /* ============================================================
     五、请求体上限
     ============================================================ */
  console.log("\n【五】请求体上限");

  ok("上限不低于 1 MB（容纳重度用户）", BODY_LIMIT >= 1024 * 1024,
    `实际 ${(BODY_LIMIT / 1024).toFixed(0)} KB`);

  {
    const reg = await req("POST", "/api/register", {
      body: { username: "body_" + Date.now().toString(36), password: "body123456" }
    });
    const token = reg.body.token;

    /* 超限请求应返回 413 而非断开连接 */
    let status = 0, errMsg = "";
    try {
      const r = await req("PUT", "/api/progress", {
        token,
        body: { progress: { notes: { x: { text: "y".repeat(BODY_LIMIT + 1024 * 1024) } } } }
      });
      status = r.status;
      errMsg = (r.body && r.body.error) || "";
    } catch (e) {
      problems.push(`超限请求抛异常而非返回 413：${e.code || e.message}`);
      fail++;
    }

    ok("超限请求返回 413", status === 413, `实际 ${status}`);
    ok("413 响应含可读错误信息", /过大/.test(errMsg), `实际「${errMsg}」`);

    /* 正常大小的请求仍应成功 */
    const normal = await req("PUT", "/api/progress", {
      token, body: { progress: { notes: { ok: { text: "正常笔记", updatedAt: 1, createdAt: 1 } } } }
    });
    ok("正常请求不受影响", normal.status === 200, `实际 ${normal.status}`);
  }

  /* ============================================================
     六、限流
     ============================================================ */
  console.log("\n【六】接口限流");

  ok("注册有限流配置", RL.LIMITS.register && RL.LIMITS.register.max > 0);
  ok("登录有限流配置", RL.LIMITS.login && RL.LIMITS.login.max > 0);
  ok("写入有限流配置", RL.LIMITS.write && RL.LIMITS.write.max > 0);

  {
    RL.reset();
    const max = RL.LIMITS.register.max;
    let allowed = 0, blocked = 0;

    for (let i = 0; i < max + 3; i++) {
      const r = await req("POST", "/api/register", {
        body: { username: `rl_${Date.now().toString(36)}_${i}`, password: "rl123456" }
      });
      if (r.status === 429) blocked++;
      else if (r.status === 200) allowed++;
    }

    ok("达到阈值后开始限流", blocked > 0, `允许 ${allowed}，拒绝 ${blocked}`);
    ok("限流不早于阈值", allowed >= max, `允许 ${allowed} < 阈值 ${max}`);

    /* 限流响应应带可读信息 */
    const r = await req("POST", "/api/register", {
      body: { username: "rl_over_" + Date.now().toString(36), password: "rl123456" }
    });
    ok("限流响应含提示", r.status === 429 && /频繁/.test((r.body && r.body.error) || ""),
      `status=${r.status}`);
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
    console.log("\n✓ 压缩、缓存、事件循环、数据裁剪、请求体上限与限流均符合预期。");
  }
  console.log("=".repeat(66));
}

server.listen(PORT, async () => {
  try {
    await main();
  } catch (e) {
    fail++;
    problems.push("执行异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(1, 4).join("\n"));
    console.log(`通过：${pass}    失败：${fail}`);
    problems.forEach(p => console.log("  - " + p));
  }
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  server.close(() => process.exit(fail ? 1 : 0));
});
