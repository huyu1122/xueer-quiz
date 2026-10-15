/**
 * 服务端集成测试
 * 启动真实 HTTP 服务，覆盖注册/登录/会话/题库/进度/越权/防爆破。
 * 运行： node test/server.test.js
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const os = require("os");

/* 用独立临时数据目录，避免污染正式数据 */
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-test-"));
process.env.QUIZ_DATA_DIR = TEST_DATA;

const PORT = 34567;
process.env.PORT = String(PORT);
const { server } = require("../server/server");

/* ---------- HTTP 小工具 ---------- */
function request(method, urlPath, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (token) headers["authorization"] = "Bearer " + token;

    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: urlPath, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => { raw += c; });
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch { /* 静态资源等非 JSON */ }
        resolve({ status: res.statusCode, body: json, raw, headers: res.headers });
      });
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------- 断言 ---------- */
let pass = 0, fail = 0;
const problems = [];

function ok(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); }
}

function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

/* ---------- 用例 ---------- */
async function run() {
  const uname = "stu_" + Date.now().toString(36);
  let token = null;
  let userId = null;

  /* ===== 1. 静态资源 ===== */
  {
    const r = await request("GET", "/");
    eq("首页返回 200", r.status, 200);
    ok("首页是 HTML", /<html/i.test(r.raw));

    const css = await request("GET", "/css/style.css");
    eq("样式表返回 200", css.status, 200);

    const js = await request("GET", "/js/app.js");
    eq("前端脚本返回 200", js.status, 200);
  }

  /* ===== 2. 目录穿越防护 ===== */
  {
    const a = await request("GET", "/../server/db.js");
    ok("阻止 ../ 穿越读取后端源码", a.status === 403 || a.status === 404, `实际 ${a.status}`);

    const b = await request("GET", "/server/db.js");
    eq("阻止直接访问 server/ 目录", b.status, 403);

    const c = await request("GET", "/server/data/users.json");
    ok("阻止访问数据文件", c.status === 403 || c.status === 404, `实际 ${c.status}`);
  }

  /* ===== 3. 注册校验 ===== */
  {
    const short = await request("POST", "/api/register", { body: { username: "ab", password: "123456" } });
    eq("拒绝过短用户名", short.status, 400);

    const weak = await request("POST", "/api/register", { body: { username: uname, password: "123" } });
    eq("拒绝过短密码", weak.status, 400);

    const badChars = await request("POST", "/api/register", { body: { username: "bad name!", password: "123456" } });
    eq("拒绝非法字符用户名", badChars.status, 400);
  }

  /* ===== 4. 正常注册 ===== */
  {
    const r = await request("POST", "/api/register", {
      body: { username: uname, password: "quiz123456", nickname: "测试同学" }
    });
    eq("注册成功返回 200", r.status, 200);
    ok("注册返回用户信息", !!(r.body && r.body.user && r.body.user.id));
    eq("昵称正确保存", r.body.user.nickname, "测试同学");
    ok("注册不下发密码哈希", !JSON.stringify(r.body).includes("hash"));
    ok("注册设置 sid Cookie", /sid=/.test(r.headers["set-cookie"] || ""));
    token = r.body.token;
    userId = r.body.user.id;
  }

  /* ===== 5. 重复注册 ===== */
  {
    const r = await request("POST", "/api/register", { body: { username: uname, password: "quiz123456" } });
    eq("拒绝重复用户名", r.status, 400);
  }

  /* ===== 6. 登录 ===== */
  {
    const wrong = await request("POST", "/api/login", { body: { username: uname, password: "wrongpass" } });
    eq("错误密码返回 401", wrong.status, 401);

    const okLogin = await request("POST", "/api/login", { body: { username: uname, password: "quiz123456" } });
    eq("正确密码登录成功", okLogin.status, 200);
    ok("登录返回 token", !!okLogin.body.token);
    token = okLogin.body.token;
  }

  /* ===== 7. 会话 ===== */
  {
    const me = await request("GET", "/api/me", { token });
    eq("凭 token 获取当前用户", me.status, 200);
    eq("当前用户 id 匹配", me.body.user.id, userId);

    const noToken = await request("GET", "/api/me");
    eq("无 token 访问 /api/me 返回 401", noToken.status, 401);

    const fake = await request("GET", "/api/me", { token: "deadbeef".repeat(8) });
    eq("伪造 token 返回 401", fake.status, 401);
  }

  /* ===== 8. 服务端题库 ===== */
  {
    const all = await request("GET", "/api/questions");
    eq("题库接口返回 200", all.status, 200);
    ok("题库已播种（>0 题）", all.body.total > 0, `实际 ${all.body.total}`);
    ok("返回题目数组", Array.isArray(all.body.questions));

    const total = all.body.total;

    const one = await request("GET", "/api/questions?limit=5");
    eq("limit 生效", one.body.count, 5);
    eq("limit 不改变 total", one.body.total, total);

    const subj = await request("GET", "/api/questions?subject=" + encodeURIComponent("高等数学"));
    ok("按学科筛选生效", subj.body.total > 0 && subj.body.questions.every(q => q.subject === "高等数学"),
      `total=${subj.body.total}`);

    const diff = await request("GET", "/api/questions?difficulty=1");
    ok("按难度筛选生效", diff.body.questions.every(q => q.difficulty === 1));

    const type = await request("GET", "/api/questions?type=fill");
    ok("按题型筛选生效", type.body.total > 0 && type.body.questions.every(q => q.type === "fill"));

    const kw = await request("GET", "/api/questions?q=" + encodeURIComponent("极限"));
    ok("关键词搜索生效", kw.body.total > 0 && kw.body.questions.every(q => q.stem.includes("极限")),
      `total=${kw.body.total}`);

    const meta = await request("GET", "/api/meta");
    eq("元信息接口返回 200", meta.status, 200);
    ok("元信息含学科统计", meta.body.subjectCount > 0);
    ok("元信息题目数与题库一致", meta.body.total === total);

    const firstId = all.body.questions[0].id;
    const single = await request("GET", "/api/questions/" + firstId);
    eq("按 id 取单题成功", single.status, 200);
    eq("单题 id 匹配", single.body.question.id, firstId);

    const missing = await request("GET", "/api/questions/no-such-id");
    eq("不存在的题返回 404", missing.status, 404);
  }

  /* ===== 9. 学习进度 ===== */
  {
    const noAuth = await request("GET", "/api/progress");
    eq("未登录读取进度返回 401", noAuth.status, 401);

    const noAuthPut = await request("PUT", "/api/progress", { body: { progress: {} } });
    eq("未登录写入进度返回 401", noAuthPut.status, 401);

    const init = await request("GET", "/api/progress", { token });
    eq("初始进度为空记录", Object.keys(init.body.progress.records).length, 0);

    /* 增量上报：答对一题、答错一题 */
    const a1 = await request("POST", "/api/progress/answer", {
      token, body: { questionId: "m-001", correct: true }
    });
    eq("答对上报成功", a1.status, 200);
    eq("记录 attempts=1", a1.body.record.attempts, 1);
    eq("记录 correct=1", a1.body.record.correct, 1);

    const a2 = await request("POST", "/api/progress/answer", {
      token, body: { questionId: "m-002", correct: false }
    });
    eq("答错上报成功", a2.status, 200);

    const after = await request("GET", "/api/progress", { token });
    const p = after.body.progress;
    eq("进度已持久化 attempts", p.records["m-001"].attempts, 1);
    ok("答错题进入错题本", !!p.wrong["m-002"]);
    eq("错题标记未订正", p.wrong["m-002"].cleared, false);
    ok("每日统计已记录", Object.values(p.daily).some(d => d.answered === 2));
    eq("连续打卡为 1 天", p.streak.days, 1);

    /* 答对同一题 → 标记已订正 */
    await request("POST", "/api/progress/answer", { token, body: { questionId: "m-002", correct: true } });
    const after2 = await request("GET", "/api/progress", { token });
    eq("重做答对后标记已订正", after2.body.progress.wrong["m-002"].cleared, true);

    /* 非法参数 */
    const bad = await request("POST", "/api/progress/answer", { token, body: { questionId: 123, correct: "yes" } });
    eq("非法参数返回 400", bad.status, 400);

    /* 整体保存（服务端会与已有进度合并，而非覆盖） */
    const put = await request("PUT", "/api/progress", {
      token,
      body: { progress: { records: { x: { attempts: 3, correct: 2, wrong: 1 } }, favorites: { "m-003": { addedAt: 1 } } } }
    });
    eq("整体保存成功", put.status, 200);
    const afterPut = await request("GET", "/api/progress", { token });
    eq("保存后记录生效", afterPut.body.progress.records.x.attempts, 3);
    ok("保存后收藏生效", !!afterPut.body.progress.favorites["m-003"]);
    ok("保存保留每日统计字段", typeof afterPut.body.progress.daily === "object");

    /* 关键：PUT 是合并而非覆盖 —— 先前记录的题不应被抹掉 */
    ok("PUT 不会覆盖已有记录（合并语义）",
      !!afterPut.body.progress.records["m-001"],
      `已有记录 m-001 丢失：records=${JSON.stringify(Object.keys(afterPut.body.progress.records))}`);
    ok("PUT 不会覆盖已有错题本",
      !!afterPut.body.progress.wrong["m-002"] || Object.keys(afterPut.body.progress.wrong).length > 0);

    /* 显式覆盖模式：mode=replace 用于「清空」等场景 */
    const replace = await request("PUT", "/api/progress?mode=replace", {
      token,
      body: { progress: { records: { only: { attempts: 1, correct: 1, wrong: 0 } } } }
    });
    eq("replace 模式保存成功", replace.status, 200);
    const afterReplace = await request("GET", "/api/progress", { token });
    ok("replace 模式确实覆盖（旧记录被清掉）",
      !afterReplace.body.progress.records["m-001"] && !!afterReplace.body.progress.records.only,
      `records=${JSON.stringify(Object.keys(afterReplace.body.progress.records))}`);
  }

  /* ===== 10. 用户数据隔离 ===== */
  {
    const other = "stu2_" + Date.now().toString(36);
    const r2 = await request("POST", "/api/register", { body: { username: other, password: "quiz123456" } });
    const t2 = r2.body.token;

    const p2 = await request("GET", "/api/progress", { token: t2 });
    eq("新用户看不到他人进度", Object.keys(p2.body.progress.records).length, 0);
    ok("新用户错题本为空", Object.keys(p2.body.progress.wrong).length === 0);
  }

  /* ===== 11. 登出 ===== */
  {
    const out = await request("POST", "/api/logout", { token });
    eq("登出成功", out.status, 200);

    const me = await request("GET", "/api/me", { token });
    eq("登出后 token 失效", me.status, 401);
  }

  /* ===== 12. 防爆破 ===== */
  {
    const target = "brute_" + Date.now().toString(36);
    await request("POST", "/api/register", { body: { username: target, password: "quiz123456" } });

    let locked = false;
    for (let i = 0; i < 8; i++) {
      const r = await request("POST", "/api/login", { body: { username: target, password: "bad" + i } });
      if (r.status === 401 && /次数过多/.test(r.body.error || "")) { locked = true; break; }
    }
    ok("连续失败触发临时锁定", locked);

    const stillWrong = await request("POST", "/api/login", { body: { username: target, password: "quiz123456" } });
    ok("锁定期内即使密码正确也被拒", stillWrong.status === 401, `实际 ${stillWrong.status}`);
  }

  /* ===== 13. 管理员接口保护 ===== */
  {
    delete process.env.ADMIN_TOKEN;
    const noToken = await request("POST", "/api/admin/reseed", { body: {} });
    eq("未配置 ADMIN_TOKEN 时禁用播种接口", noToken.status, 403);

    process.env.ADMIN_TOKEN = "test-admin-token";
    const wrongTok = await request("POST", "/api/admin/reseed", { body: { token: "nope" } });
    eq("错误管理员口令被拒", wrongTok.status, 403);

    const good = await request("POST", "/api/admin/reseed", { body: { token: "test-admin-token" } });
    eq("正确管理员口令可重新播种", good.status, 200);
    ok("重新播种返回题量", good.body.count > 0);
    delete process.env.ADMIN_TOKEN;
  }

  /* ===== 14. 错误处理 ===== */
  {
    const notFound = await request("GET", "/api/nope");
    eq("未知接口返回 404", notFound.status, 404);

    const badJson = await new Promise((resolve) => {
      const req = http.request({
        host: "127.0.0.1", port: PORT, method: "POST", path: "/api/login",
        headers: { "content-type": "application/json" }
      }, (res) => {
        let raw = ""; res.on("data", c => raw += c);
        res.on("end", () => resolve({ status: res.statusCode, raw }));
      });
      req.write("{ not json ");
      req.end();
    });
    eq("非法 JSON 返回 400", badJson.status, 400);

    const wrongMethod = await request("DELETE", "/api/questions");
    ok("不支持的方法被拒绝", [404, 405].includes(wrongMethod.status), `实际 ${wrongMethod.status}`);
  }
}

/* ---------- 执行 ---------- */
server.listen(PORT, async () => {
  console.log("=".repeat(58));
  console.log("服务端集成测试");
  console.log("=".repeat(58));

  try {
    await run();
  } catch (e) {
    fail++;
    problems.push("测试执行异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(1, 4).join("\n"));
  }

  console.log(`通过：${pass}    失败：${fail}`);
  if (problems.length) {
    console.log("\n✗ 失败项：");
    problems.forEach(p => console.log("  - " + p));
  } else {
    console.log("\n✓ 服务端全部接口行为符合预期。");
  }

  /* 清理临时数据目录 */
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch { /* 忽略 */ }

  server.close(() => process.exit(fail ? 1 : 0));
});
