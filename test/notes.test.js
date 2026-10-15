/**
 * 笔记与每日目标的真实 HTTP 同步验证
 * 用 Node 发起请求，避免 PowerShell 管道的编码干扰。
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-note-"));
process.env.QUIZ_DATA_DIR = TEST_DATA;
process.env.PORT = "8871";
const PORT = 8871;

const { server } = require("../server/server");

function req(method, p, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {};
    if (payload) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }
    if (token) headers["authorization"] = "Bearer " + token;
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}

let pass = 0, fail = 0;
const problems = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; problems.push(`${name}${detail ? " → " + detail : ""}`); }
};

async function main() {
  console.log("=".repeat(64));
  console.log("笔记与每日目标 —— 真实 HTTP 同步验证");
  console.log("=".repeat(64));

  const uname = "note_" + Date.now().toString(36);
  const reg = await req("POST", "/api/register", {
    body: { username: uname, password: "note123456", nickname: "笔记测试" }
  });
  const tA = reg.body.token;
  const loginB = await req("POST", "/api/login", { body: { username: uname, password: "note123456" } });
  const tB = loginB.body.token;
  ok("两台设备建立独立会话", tA !== tB);

  /* ---------- 笔记 LWW ---------- */
  const NOTE_A = "A端笔记：重要极限要记牢";
  const NOTE_B = "B端更新：等价无穷小替换要小心";

  await req("PUT", "/api/progress", {
    token: tA,
    body: { progress: { notes: { "m-001": { text: NOTE_A, updatedAt: 1000, createdAt: 1000 } } } }
  });
  await req("PUT", "/api/progress", {
    token: tB,
    body: { progress: { notes: { "m-001": { text: NOTE_B, updatedAt: 2000, createdAt: 1000 } } } }
  });

  let prog = (await req("GET", "/api/progress", { token: tA })).body.progress;
  ok("笔记 LWW 取较新版本（含中文正确传输）",
    prog.notes["m-001"] && prog.notes["m-001"].text === NOTE_B,
    `实际「${prog.notes["m-001"] ? prog.notes["m-001"].text : "无"}」`);
  console.log(`  设备A 读到笔记：${prog.notes["m-001"].text}`);
  ok("笔记保留最早 createdAt", prog.notes["m-001"].createdAt === 1000,
    `实际 ${prog.notes["m-001"].createdAt}`);

  /* ---------- 笔记删除意图同步 ---------- */
  await req("PUT", "/api/progress", {
    token: tB,
    body: { progress: { notes: { "m-001": { text: "", updatedAt: 3000, createdAt: 1000 } } } }
  });
  prog = (await req("GET", "/api/progress", { token: tA })).body.progress;
  ok("删除意图同步到另一设备（空文本）",
    prog.notes["m-001"] && prog.notes["m-001"].text === "",
    `实际「${prog.notes["m-001"] ? prog.notes["m-001"].text : "无"}」`);

  /* ---------- 多题笔记并集 ---------- */
  await req("PUT", "/api/progress", {
    token: tA,
    body: { progress: { notes: { "m-002": { text: "A 的笔记", updatedAt: 4000, createdAt: 4000 } } } }
  });
  await req("PUT", "/api/progress", {
    token: tB,
    body: { progress: { notes: { "l-001": { text: "B 的笔记", updatedAt: 5000, createdAt: 5000 } } } }
  });
  prog = (await req("GET", "/api/progress", { token: tA })).body.progress;
  ok("不同题目的笔记取并集",
    !!prog.notes["m-002"] && !!prog.notes["l-001"],
    `keys=${JSON.stringify(Object.keys(prog.notes))}`);

  /* ---------- 超长笔记截断 ---------- */
  await req("PUT", "/api/progress", {
    token: tA,
    body: { progress: { notes: { "m-003": { text: "x".repeat(9999), updatedAt: 6000, createdAt: 6000 } } } }
  });
  prog = (await req("GET", "/api/progress", { token: tA })).body.progress;
  const len = prog.notes["m-003"].text.length;
  ok("超长笔记被截断到 2000 字以内", len <= 2000, `实际 ${len}`);

  /* ---------- 每日目标 ---------- */
  await req("PUT", "/api/progress", {
    token: tA,
    body: { progress: { goals: { dailyQuestions: 25, dailyMinutes: 0, updatedAt: 1000 } } }
  });
  await req("PUT", "/api/progress", {
    token: tB,
    body: { progress: { goals: { dailyQuestions: 50, dailyMinutes: 30, updatedAt: 2000 } } }
  });
  prog = (await req("GET", "/api/progress", { token: tA })).body.progress;
  ok("目标跨设备取较新配置", prog.goals.dailyQuestions === 50 && prog.goals.dailyMinutes === 30,
    `实际 ${prog.goals.dailyQuestions} 题 / ${prog.goals.dailyMinutes} 分钟`);
  console.log(`  目标同步结果：${prog.goals.dailyQuestions} 题 / ${prog.goals.dailyMinutes} 分钟`);

  /* ---------- 目标数值钳制 ---------- */
  await req("PUT", "/api/progress", {
    token: tA,
    body: { progress: { goals: { dailyQuestions: 99999, dailyMinutes: -99, updatedAt: 9000 } } }
  });
  prog = (await req("GET", "/api/progress", { token: tA })).body.progress;
  ok("目标题量上限被钳制", prog.goals.dailyQuestions <= 500, `实际 ${prog.goals.dailyQuestions}`);
  ok("目标时长下限被钳制", prog.goals.dailyMinutes >= 0, `实际 ${prog.goals.dailyMinutes}`);

  /* ---------- 答题累加到今日进度 ---------- */
  await req("POST", "/api/progress/answer", { token: tA, body: { questionId: "m-001", correct: true } });
  await req("POST", "/api/progress/answer", { token: tA, body: { questionId: "m-002", correct: false } });
  prog = (await req("GET", "/api/progress", { token: tA })).body.progress;

  const M = require(path.join(ROOT, "js", "merge.js"));
  const today = M.dayKey();
  ok("今日答题数正确累加", prog.daily[today].answered === 2,
    `实际 ${prog.daily[today] ? prog.daily[today].answered : 0}`);
  ok("今日答对数正确", prog.daily[today].correct === 1,
    `实际 ${prog.daily[today] ? prog.daily[today].correct : 0}`);

  /* 用合并模块计算目标进度 */
  const gp = M.goalProgress(prog);
  ok("目标进度计算正确", gp.done === 2 && gp.target === 500,
    `done=${gp.done} target=${gp.target}`);
  console.log(`  今日进度：${gp.done}/${gp.target} = ${gp.percent}%`);
  console.log(`  目标历史：${M.goalHistory(prog, 14).length} 天`);

  /* ---------- 非法结构安全处理 ---------- */
  const bad = await req("PUT", "/api/progress", {
    token: tA,
    body: { progress: { notes: "not-an-object", goals: 12345 } }
  });
  ok("非法 notes/goals 结构不导致错误", bad.status === 200, `status=${bad.status}`);
  prog = (await req("GET", "/api/progress", { token: tA })).body.progress;
  ok("非法结构退化为空对象",
    typeof prog.notes === "object" && typeof prog.goals === "object");

  /* ---------- 用户隔离 ---------- */
  const other = "note2_" + Date.now().toString(36);
  const r2 = await req("POST", "/api/register", { body: { username: other, password: "note123456" } });
  const p2 = (await req("GET", "/api/progress", { token: r2.body.token })).body.progress;
  ok("他人看不到我的笔记", Object.keys(p2.notes).length === 0);

  console.log("\n" + "=".repeat(64));
  console.log(`通过：${pass}    失败：${fail}`);
  if (problems.length) {
    console.log("\n✗ 问题：");
    problems.forEach(p => console.log("  - " + p));
  } else {
    console.log("\n✓ 笔记与每日目标：LWW 同步、删除意图、长度限制、目标钳制均正确。");
  }
  console.log("=".repeat(64));
}

server.listen(PORT, async () => {
  try {
    await main();
  } catch (e) {
    fail++;
    problems.push("异常：" + e.message);
    console.log(`通过：${pass}    失败：${fail}`);
    problems.forEach(p => console.log("  - " + p));
  }
  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  server.close(() => process.exit(fail ? 1 : 0));
});
