/**
 * 端到端验收：启动真实服务，模拟浏览器完整走一遍
 * 注册 → 答题上报 → 换设备登录 → 进度恢复 → 跨设备隔离
 * 运行： node test/e2e.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-e2e-"));
process.env.QUIZ_DATA_DIR = TEST_DATA;
process.env.PORT = "34568";
const PORT = 34568;

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
        resolve({ status: res.statusCode, body: json, raw });
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
  console.log("=".repeat(58));
  console.log("端到端验收（模拟真实用户流程）");
  console.log("=".repeat(58));

  /* ---------- 场景 1：新用户注册并开始刷题 ---------- */
  console.log("\n【场景 1】学生 A 在宿舍电脑上注册并刷题");

  const reg = await req("POST", "/api/register", {
    body: { username: "xiaoming", password: "study2026", nickname: "小明" }
  });
  ok("A 注册成功", reg.status === 200, `status=${reg.status}`);
  const tokenA = reg.body.token;

  const meta = await req("GET", "/api/meta");
  ok("获取题库元信息", meta.status === 200);
  ok("题库有足够题目", meta.body.total >= 100, `实际 ${meta.body.total}`);
  console.log(`    题库：${meta.body.total} 题 / ${meta.body.subjectCount} 学科 / ${meta.body.chapterCount} 章节`);

  /* 做 10 道题：6 对 4 错 */
  const qs = (await req("GET", "/api/questions?limit=10")).body.questions;
  ok("拉到 10 道题", qs.length === 10);

  for (let i = 0; i < qs.length; i++) {
    const correct = i < 6;
    await req("POST", "/api/progress/answer", {
      token: tokenA, body: { questionId: qs[i].id, correct }
    });
  }

  let progA = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
  const answeredA = Object.values(progA.records).reduce((s, r) => s + r.attempts, 0);
  ok("A 答题数正确（10 题）", answeredA === 10, `实际 ${answeredA}`);
  const wrongCountA = Object.keys(progA.wrong).length;
  ok("A 错题本收录 4 题", wrongCountA === 4, `实际 ${wrongCountA}`);
  console.log(`    答题 10 次，错题本 ${wrongCountA} 题，连续打卡 ${progA.streak.days} 天`);

  /* 收藏 + 交一次考试 */
  await req("PUT", "/api/progress", {
    token: tokenA,
    body: {
      progress: {
        ...progA,
        favorites: { [qs[0].id]: { addedAt: Date.now() } },
        exams: [{ id: "exam1", at: Date.now(), subject: "高数模拟考", total: 10, right: 7, score: 70, durationSec: 600, detail: [] }]
      }
    }
  });
  progA = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
  ok("收藏已保存", !!progA.favorites[qs[0].id]);
  ok("考试记录已保存", (progA.exams || []).length === 1);
  console.log(`    收藏 1 题，考试记录 ${progA.exams.length} 条`);

  /* ---------- 场景 2：换设备登录，进度恢复 ---------- */
  console.log("\n【场景 2】小明换到图书馆电脑登录，检查进度是否还在");

  const login2 = await req("POST", "/api/login", {
    body: { username: "xiaoming", password: "study2026" }
  });
  ok("新设备登录成功", login2.status === 200);
  const tokenA2 = login2.body.token;
  ok("两次登录 token 不同（独立会话）", tokenA2 !== tokenA);

  const progA2 = (await req("GET", "/api/progress", { token: tokenA2 })).body.progress;
  const answeredA2 = Object.values(progA2.records).reduce((s, r) => s + r.attempts, 0);
  ok("换设备后答题记录完整恢复", answeredA2 === 10, `实际 ${answeredA2}`);
  ok("换设备后错题本恢复", Object.keys(progA2.wrong).length === 4);
  ok("换设备后收藏恢复", !!progA2.favorites[qs[0].id]);
  ok("换设备后考试记录恢复", (progA2.exams || []).length === 1);
  console.log("    ✓ 进度、错题本、收藏、考试记录全部恢复");

  /* ---------- 场景 3：另一学生数据隔离 ---------- */
  console.log("\n【场景 3】同宿舍同学 B 注册，确认看不到 A 的数据");

  const regB = await req("POST", "/api/register", {
    body: { username: "xiaohong", password: "hong2026", nickname: "小红" }
  });
  ok("B 注册成功", regB.status === 200);
  const tokenB = regB.body.token;

  const progB = (await req("GET", "/api/progress", { token: tokenB })).body.progress;
  ok("B 的答题记录为空", Object.keys(progB.records).length === 0);
  ok("B 的错题本为空", Object.keys(progB.wrong).length === 0);
  ok("B 的收藏为空", Object.keys(progB.favorites).length === 0);
  ok("B 的考试记录为空", (progB.exams || []).length === 0);
  console.log("    ✓ 用户数据完全隔离");

  /* ---------- 场景 4：B 的作答不影响 A ---------- */
  await req("POST", "/api/progress/answer", { token: tokenB, body: { questionId: qs[0].id, correct: false } });
  const progA3 = (await req("GET", "/api/progress", { token: tokenA2 })).body.progress;
  ok("B 答题后 A 的记录未被污染", Object.values(progA3.records).reduce((s, r) => s + r.attempts, 0) === 10);

  // A 之前答对过 qs[0]，B 答错不应把该题塞进 A 的错题本
  const aWrongBefore = 4;
  ok("B 的错题未混入 A 的错题本", Object.keys(progA3.wrong).length === aWrongBefore,
    `A 错题数应为 ${aWrongBefore}，实际 ${Object.keys(progA3.wrong).length}`);
  ok("B 答错的题不在 A 的错题本中", !progA3.wrong[qs[0].id],
    `qs[0]=${qs[0].id} 不应出现在 A 的错题本`);

  /* ---------- 场景 5：退出登录后无法访问 ---------- */
  console.log("\n【场景 5】退出登录与安全校验");

  await req("POST", "/api/logout", { token: tokenB });
  const afterLogout = await req("GET", "/api/progress", { token: tokenB });
  ok("退出后 token 立即失效", afterLogout.status === 401);

  const noAuth = await req("GET", "/api/progress");
  ok("无凭证无法读取任何进度", noAuth.status === 401);

  /* A 的会话仍有效（B 退出不影响 A） */
  const stillA = await req("GET", "/api/me", { token: tokenA2 });
  ok("B 退出不影响 A 的会话", stillA.status === 200);

  /* ---------- 场景 6：服务端题库可被前端直接消费 ---------- */
  console.log("\n【场景 6】服务端题库结构可被前端直接使用");

  const bank = (await req("GET", "/api/questions")).body.questions;
  const needFields = ["id", "subject", "chapter", "type", "difficulty", "stem", "answer", "analysis"];
  const missing = bank.filter(q => needFields.some(f => q[f] === undefined));
  ok("所有题目字段完整", missing.length === 0, `缺失字段的题：${missing.length}`);

  const idSet = new Set(bank.map(q => q.id));
  ok("题目 id 无重复", idSet.size === bank.length, `${bank.length} 题中 ${idSet.size} 个唯一 id`);

  const typeCount = {};
  bank.forEach(q => { typeCount[q.type] = (typeCount[q.type] || 0) + 1; });
  ok("四种题型齐备", ["single", "multiple", "judge", "fill"].every(t => typeCount[t] > 0),
    JSON.stringify(typeCount));
  console.log(`    题型分布：${Object.entries(typeCount).map(([k, v]) => k + "=" + v).join(", ")}`);

  const badAnswer = bank.filter(q => q.type !== "fill" && (!Array.isArray(q.answer) || q.answer.some(i => i >= q.options.length)));
  ok("选择题答案下标均在范围内", badAnswer.length === 0, `${badAnswer.length} 题越界`);

  /* ---------- 场景 7：分页拉取全量题库（前端启动逻辑） ---------- */
  console.log("\n【场景 7】前端分页拉取全量题库");

  let all = [], offset = 0, total = Infinity;
  while (all.length < total) {
    const r = (await req("GET", `/api/questions?limit=500&offset=${offset}`)).body;
    total = r.total;
    all = all.concat(r.questions);
    if (!r.questions.length) break;
    offset += r.questions.length;
  }
  ok("分页拉取得到全量题目", all.length === total, `${all.length} vs ${total}`);
  ok("分页无重复", new Set(all.map(q => q.id)).size === all.length);
  console.log(`    ✓ 分 2 页拉取 ${all.length} 题，无重复无遗漏`);

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(58));
  console.log(`通过：${pass}    失败：${fail}`);
  if (problems.length) {
    console.log("\n✗ 问题：");
    problems.forEach(p => console.log("  - " + p));
  } else {
    console.log("\n✓ 端到端流程全部通过：注册、答题、跨设备同步、数据隔离、权限校验均正常。");
  }
  console.log("=".repeat(58));
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
