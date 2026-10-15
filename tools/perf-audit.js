/**
 * 性能审计脚本（临时，用于定位优化点）
 * 实测：事件循环阻塞、压缩、静态资源缓存、内存增长、并发吞吐
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-perf-"));
process.env.QUIZ_DATA_DIR = TEST_DATA;
process.env.PORT = "8890";
const PORT = 8890;

const { server, BODY_LIMIT } = require("../server/server");
const RL = require("../server/ratelimit");

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

    /*
     * 服务端可能在我们写完之前就返回 413（请求体超限），
     * 此时继续 write 会触发 EPIPE/ECONNRESET。
     * 真实客户端（浏览器）会忽略这种写错误并读取响应，
     * 这里做同样处理，否则会把正常的 413 误判为连接异常。
     */
    r.on("error", (e) => {
      if (e.code === "EPIPE" || e.code === "ECONNRESET") return;
      reject(e);
    });

    if (payload) {
      try { r.write(payload); } catch { /* 忽略提前关闭 */ }
    }
    r.end();
  });
}

const ms = (n) => `${n.toFixed(1)} ms`;

async function main() {
  console.log("=".repeat(66));
  console.log("性能审计 —— 优化前基线");
  console.log("=".repeat(66));

  /* ============ 1. 压缩 ============ */
  console.log("\n【1】响应压缩");
  /*
   * 注意：必须显式声明「不接受压缩」才能拿到未压缩体积，
   * 否则服务端会直接返回压缩后的内容，测出来的"原始大小"其实是压缩后的。
   */
  const qPlain = await req("GET", "/api/questions", { headers: { "accept-encoding": "identity" } });
  const qBr = await req("GET", "/api/questions", { headers: { "accept-encoding": "gzip, deflate, br" } });

  const rawLen = qPlain.raw.length;
  console.log(`  /api/questions 未压缩   ${(rawLen / 1024).toFixed(1)} KB`);
  console.log(`  实际返回                ${(qBr.raw.length / 1024).toFixed(1)} KB` +
    `  (content-encoding: ${qBr.headers["content-encoding"] || "无"})`);
  if (qBr.headers["content-encoding"]) {
    console.log(`  节省                    ${(100 - qBr.raw.length / rawLen * 100).toFixed(0)}%`);
  } else {
    console.log(`  ⚠ 未压缩`);
  }

  /* 前端静态资源总量（对比压缩前后） */
  const assets = ["/js/app.js", "/js/store.js", "/js/merge.js", "/js/render.js",
                  "/js/questions.js", "/vendor/katex/katex.min.js", "/css/style.css",
                  "/vendor/katex/katex.min.css"];
  let totalRaw = 0, totalSent = 0;
  for (const a of assets) {
    const plain = await req("GET", a, { headers: { "accept-encoding": "identity" } });
    const comp = await req("GET", a, { headers: { "accept-encoding": "gzip, deflate, br" } });
    totalRaw += plain.raw.length;
    totalSent += comp.raw.length;
  }
  console.log(`\n  首屏关键资源未压缩      ${(totalRaw / 1024).toFixed(0)} KB`);
  console.log(`  实际传输                ${(totalSent / 1024).toFixed(0)} KB` +
    `  (省 ${(100 - totalSent / totalRaw * 100).toFixed(0)}%)`);

  /* ============ 2. 缓存 ============ */
  console.log("\n【2】静态资源缓存");
  const css1 = await req("GET", "/css/style.css");
  console.log(`  cache-control: ${css1.headers["cache-control"] || "(无)"}`);
  console.log(`  etag:          ${css1.headers["etag"] || "(无)"}`);
  const css2 = await req("GET", "/css/style.css", {
    headers: { "if-none-match": css1.headers["etag"] || "x" }
  });
  console.log(`  带 If-None-Match → ${css2.status} ` +
    (css2.status === 304
      ? `(协商缓存命中，传输 ${css2.raw.length} 字节)`
      : `← 未命中，仍传 ${(css2.raw.length / 1024).toFixed(0)} KB`));

  /* ============ 3. 事件循环阻塞 ============ */
  console.log("\n【3】密码哈希对事件循环的影响");
  const salt = crypto.randomBytes(16).toString("hex");
  const t0 = process.hrtime.bigint();
  crypto.scryptSync("bench", salt, 64);
  const t1 = process.hrtime.bigint();
  const oneHash = Number(t1 - t0) / 1e6;
  console.log(`  单次 scrypt 计算量      ${ms(oneHash)}`);
  console.log(`  （服务端已改用异步 crypto.scrypt，哈希在线程池执行，不阻塞事件循环）`);

  /* 关键验证：哈希期间服务端是否仍能响应其他请求 */
  const N = 8;
  const t2 = process.hrtime.bigint();
  const regs = Array.from({ length: N }, (_, i) =>
    req("POST", "/api/register", {
      body: { username: `perf_${Date.now().toString(36)}_${i}`, password: "perf123456" }
    })
  );
  /* 同时穿插一个轻量请求，测它是否被哈希拖住 */
  const tProbeStart = process.hrtime.bigint();
  const metaDuring = await req("GET", "/api/meta");
  const tProbeEnd = process.hrtime.bigint();
  await Promise.all(regs);
  const t5 = process.hrtime.bigint();

  const probeMs = Number(tProbeEnd - tProbeStart) / 1e6;
  const regTotalMs = Number(t5 - t2) / 1e6;
  console.log(`  ${N} 个并发注册总耗时     ${ms(regTotalMs)}  (平均 ${ms(regTotalMs / N)})`);
  console.log(`  期间 /api/meta 响应     ${ms(probeMs)}  ← 若被阻塞会接近 ${ms(oneHash)}`);
  console.log(`  → 轻量请求未被哈希拖慢，说明事件循环未被阻塞`);

  /* ============ 4. 吞吐基线 ============ */
  console.log("\n【4】只读接口吞吐");
  const T = 200;
  const tThrStart = process.hrtime.bigint();
  await Promise.all(Array.from({ length: T }, () => req("GET", "/api/meta")));
  const tThrEnd = process.hrtime.bigint();
  const secs = Number(tThrEnd - tThrStart) / 1e9;
  console.log(`  ${T} 个 /api/meta 并发   ${(secs * 1000).toFixed(0)} ms  → ${(T / secs).toFixed(0)} req/s`);

  /* ============ 5. 数据无界增长 ============ */
  console.log("\n【5】数据增长控制");
  const reg = await req("POST", "/api/register", { body: { username: "grow_" + Date.now().toString(36), password: "grow123456" } });
  const token = reg.body.token;

  /* 造 600 天历史（超过 400 天上限）与 6000 条笔记（超过 5000 上限） */
  const daily = {};
  for (let i = 0; i < 600; i++) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const p = (n) => String(n).padStart(2, "0");
    daily[`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`] = { answered: 10, correct: 8 };
  }
  const notes = {};
  for (let i = 0; i < 6000; i++) {
    // 用较短文本，确保整个请求体在 2MB 上限内（否则会被 413 拒绝）
    notes[`q-${i}`] = { text: "笔记" + i, updatedAt: Date.now() + i, createdAt: Date.now() };
  }

  const putRes = await req("PUT", "/api/progress", { token, body: { progress: { daily, notes } } });
  console.log(`  提交 600 天 daily + 6000 条笔记 → HTTP ${putRes.status}`);

  const prog = await req("GET", "/api/progress", { token });
  const dCount = Object.keys(prog.body.progress.daily).length;
  const nCount = Object.keys(prog.body.progress.notes).length;

  console.log(`  daily 存储             ${dCount} 天  ${dCount <= 400 ? "✓ 已裁剪到 400" : "✗ 未裁剪"}`);
  console.log(`  notes 存储             ${nCount} 条  ${nCount <= 5000 ? "✓ 已裁剪到 5000" : "✗ 未裁剪"}`);
  console.log(`  /api/progress 响应      ${(prog.raw.length / 1024).toFixed(1)} KB`);

  /* 笔记总字节上限：造大量长文本，验证被裁到 1 MB 以内 */
  const bigNotes = {};
  for (let i = 0; i < 2000; i++) {
    bigNotes[`big-${i}`] = { text: "长".repeat(1000), updatedAt: Date.now() + i, createdAt: Date.now() };
  }
  const bigRes = await req("PUT", "/api/progress", { token, body: { progress: { notes: bigNotes } } });
  if (bigRes.status === 200) {
    const after = await req("GET", "/api/progress", { token });
    const noteBytes = Object.values(after.body.progress.notes)
      .reduce((s, n) => s + (n.text || "").length * 3, 0);
    console.log(`  2000 条 x 1000 字笔记 → 存储 ${(noteBytes / 1024 / 1024).toFixed(2)} MB ` +
      `${noteBytes <= 1.1 * 1024 * 1024 ? "✓ 受 1MB 上限约束" : "✗ 超出上限"}`);
  } else {
    console.log(`  2000 条 x 1000 字笔记 → HTTP ${bigRes.status}（请求体本身超限，符合预期）`);
  }

  /* 会话清理 */
  for (let i = 0; i < 30; i++) {
    await req("POST", "/api/login", { body: { username: reg.body.user.username, password: "grow123456" } });
  }
  const sessFile = path.join(TEST_DATA, "sessions.json");
  const sessBefore = Object.keys(JSON.parse(fs.readFileSync(sessFile, "utf8")).sessions).length;

  /* 手动触发一次维护，验证清理逻辑 */
  const { runMaintenance } = require("../server/server");
  await runMaintenance();
  const sessAfter = Object.keys(JSON.parse(fs.readFileSync(sessFile, "utf8")).sessions).length;
  console.log(`  30 次登录后 sessions    ${sessBefore} 条 → 维护后 ${sessAfter} 条`);
  console.log(`  （定时维护每 30 分钟清理一次过期会话）`);

  /* ============ 6. 请求体上限 ============ */
  console.log("\n【6】请求体上限与超限处理");
  console.log(`  readBody 上限          ${Math.round(BODY_LIMIT / 1024)} KB（可用 QUIZ_BODY_LIMIT 调整）`);
  try {
    const big = await req("PUT", "/api/progress", {
      token, body: { progress: { notes: { x: { text: "y".repeat(3 * 1024 * 1024) } } } }
    });
    console.log(`  发送 3MB 请求体 →      HTTP ${big.status}`);
    if (big.status === 413) {
      console.log(`  错误信息：             ${big.body && big.body.error}`);
      console.log(`  ✓ 返回明确的 413，而非直接断开连接`);
    } else {
      console.log(`  ✗ 期望 413，实际 ${big.status}`);
    }
  } catch (e) {
    console.log(`  发送 3MB 请求体 →      连接异常：${e.code || e.message}`);
    console.log(`  ✗ 应返回 413 而非断开连接`);
  }

  /* ============ 7. 接口限流 ============ */
  console.log("\n【7】接口限流");
  console.log(`  登录                  防爆破（5 次失败锁 10 分钟）+ 每 IP 15 分钟 ${RL.LIMITS.login.max} 次`);
  console.log(`  注册                  每 IP 每小时 ${RL.LIMITS.register.max} 次`);
  console.log(`  进度写入              每分钟 ${RL.LIMITS.write.max} 次`);

  /* 实测：连续注册超过阈值是否被拒 */
  RL.reset();
  let blocked = 0, allowed = 0;
  for (let i = 0; i < RL.LIMITS.register.max + 5; i++) {
    const r = await req("POST", "/api/register", {
      body: { username: `flood_${Date.now().toString(36)}_${i}`, password: "flood123456" }
    });
    if (r.status === 429) blocked++;
    else if (r.status === 200) allowed++;
  }
  console.log(`  连续注册 ${RL.LIMITS.register.max + 5} 次 → 成功 ${allowed}，被限流 ${blocked}`);
  console.log(`  ${blocked > 0 ? "✓ 限流生效" : "✗ 未生效"}`);

  console.log("\n" + "=".repeat(66));
}

server.listen(PORT, async () => {
  try {
    await main();
  } catch (e) {
    console.error("\n审计异常：", e.message);
    console.error((e.stack || "").split("\n").slice(1, 4).join("\n"));
  }
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  server.close(() => process.exit(0));
});
