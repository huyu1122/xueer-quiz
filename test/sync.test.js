/**
 * P0 回归测试 —— 多设备并发同步零丢失
 *
 * 背景：早期版本前端答题后调用 PUT /api/progress 整体覆盖，
 * 导致「设备 A 答题 → 设备 B 基于旧快照提交 → A 的记录被抹掉」。
 *
 * 本测试固化以下不变量，防止回归：
 *   1. 两台设备并发提交，双方记录都必须保留
 *   2. 合并满足交换律：A→B 与 B→A 结果一致
 *   3. 合并满足幂等性：重复提交同一份数据不改变结果
 *   4. 合并单调不减：任何计数只增不减
 *   5. 增量上报路径无丢失
 *   6. 高频交替提交（模拟真实刷题）零丢失
 *
 * 运行： node test/sync.test.js
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TEST_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "quiz-sync-"));
process.env.QUIZ_DATA_DIR = TEST_DATA;
process.env.PORT = "34570";
const PORT = 34570;

const ROOT = path.join(__dirname, "..");
const M = require(path.join(ROOT, "js", "merge.js"));
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

const emptyP = () => M.emptyProgress();
const withRecord = (id, correct, ts) => {
  const p = emptyP();
  p.records[id] = { attempts: 1, correct: correct ? 1 : 0, wrong: correct ? 0 : 1, lastResult: correct ? "correct" : "wrong", lastAt: ts || Date.now() };
  if (!correct) p.wrong[id] = { addedAt: ts || Date.now(), count: 1, cleared: false };
  return p;
};

/* ============================================================
   一、纯函数层：合并代数性质
   ============================================================ */
function testMergeAlgebra() {
  console.log("\n【一】合并函数的代数性质（纯逻辑，无需服务端）");

  /* 1. 交换律 */
  {
    const a = withRecord("q-A", true, 1000);
    const b = withRecord("q-B", false, 2000);
    const ab = M.mergeProgress(a, b);
    const ba = M.mergeProgress(b, a);
    const same = JSON.stringify(ab) === JSON.stringify(ba);
    ok("合并满足交换律 merge(a,b) === merge(b,a)", same,
      same ? "" : `\n      ab=${JSON.stringify(ab.records)}\n      ba=${JSON.stringify(ba.records)}`);
  }

  /* 2. 幂等性 */
  {
    const a = withRecord("q-A", true, 1000);
    const once = M.mergeProgress(a, a);
    const twice = M.mergeProgress(once, a);
    ok("合并满足幂等性 merge(merge(a,a),a) === merge(a,a)",
      JSON.stringify(once) === JSON.stringify(twice));
  }

  /* 3. 单调不减 */
  {
    const a = withRecord("q-A", true, 1000);
    const b = withRecord("q-A", false, 2000);
    const m = M.mergeProgress(a, b);
    ok("合并后 attempts 不减", m.records["q-A"].attempts >= 1);
    ok("合并后 correct 不减", m.records["q-A"].correct >= 1);
    ok("合并后 wrong 不减", m.records["q-A"].wrong >= 1);
  }

  /* 4. 双方记录都保留（核心不变量） */
  {
    const a = withRecord("q-A", true, 1000);
    const b = withRecord("q-B", false, 2000);
    const m = M.mergeProgress(a, b);
    ok("合并保留 A 方记录", !!m.records["q-A"]);
    ok("合并保留 B 方记录", !!m.records["q-B"]);
    ok("合并保留 B 方错题", !!m.wrong["q-B"]);
  }

  /* 5. 空值鲁棒性 */
  {
    const m1 = M.mergeProgress({}, {});
    ok("空对象合并不报错", !!m1.records && !!m1.wrong && !!m1.review);
    const m2 = M.mergeProgress(null, undefined);
    ok("null/undefined 合并不报错", !!m2.records);
    const m3 = M.mergeProgress({ records: "bad" }, { wrong: 123 });
    ok("非法类型退化为空对象", typeof m3.records === "object" && typeof m3.wrong === "object");
  }

  /* 6. 错题本订正语义：两端都订正才算订正 */
  {
    const a = emptyP(), b = emptyP();
    a.wrong["q1"] = { addedAt: 1, count: 2, cleared: true };
    b.wrong["q1"] = { addedAt: 2, count: 3, cleared: false };
    const m = M.mergeProgress(a, b);
    ok("一端未订正则合并后为未订正", m.wrong["q1"].cleared === false);
    ok("错题次数取较大值", m.wrong["q1"].count === 3);

    b.wrong["q1"].cleared = true;
    const m2 = M.mergeProgress(a, b);
    ok("两端都订正才为已订正", m2.wrong["q1"].cleared === true);
  }

  /* 7. 考试记录去重 */
  {
    const a = emptyP(), b = emptyP();
    a.exams = [{ id: "e1", at: 100 }];
    b.exams = [{ id: "e1", at: 100 }, { id: "e2", at: 200 }];
    const m = M.mergeProgress(a, b);
    ok("考试记录按 id 去重", m.exams.length === 2, `实际 ${m.exams.length}`);
    ok("考试记录按时间倒序", m.exams[0].id === "e2");
  }

  /* 8. review 调度合并：不因同步而提前 */
  {
    const a = emptyP(), b = emptyP();
    a.review["q1"] = { stage: 3, dueAt: 5000, lastAt: 1000, ease: 2.5, lapses: 0 };
    b.review["q1"] = { stage: 1, dueAt: 2000, lastAt: 500, ease: 2.3, lapses: 1 };
    const m = M.mergeProgress(a, b);
    ok("review 取更大 stage", m.review["q1"].stage === 3);
    ok("review 取更晚到期时间（不提前复习）", m.review["q1"].dueAt === 5000);
  }
}

/* ============================================================
   二、间隔重复算法
   ============================================================ */
function testReviewScheduler() {
  console.log("\n【二】间隔重复调度（简化版 SM-2）");

  const t0 = 1700000000000;
  let r = M.scheduleReview(undefined, true, t0);
  ok("首次答对进入阶段 1", r.stage === 1, `实际 ${r.stage}`);
  ok("首次答对间隔 1 天", r.dueAt === t0 + 86400000, `实际 ${(r.dueAt - t0) / 86400000} 天`);

  r = M.scheduleReview(r, true, t0);
  ok("连续答对阶段递增到 2", r.stage === 2, `实际 ${r.stage}`);
  ok("阶段 2 间隔 3 天", r.dueAt === t0 + 3 * 86400000);

  r = M.scheduleReview(r, true, t0);
  ok("阶段 3 间隔 7 天", r.dueAt === t0 + 7 * 86400000, `实际 ${(r.dueAt - t0) / 86400000} 天`);

  /* 答错回退 */
  const before = M.scheduleReview(undefined, true, t0);
  const after = M.scheduleReview(before, false, t0);
  ok("答错后阶段回退", after.stage < before.stage, `${before.stage} → ${after.stage}`);
  ok("答错后记录遗忘次数", after.lapses === 1);
  ok("答错后间隔缩短到 1 天内", after.dueAt - t0 <= 86400000);

  /* 阶段不会超过上限 */
  let s = undefined;
  for (let i = 0; i < 30; i++) s = M.scheduleReview(s, true, t0);
  ok("阶段封顶不越界", s.stage === M.INTERVALS_DAYS.length - 1, `实际 ${s.stage}`);

  /* 到期筛选 */
  const now = t0 + 10 * 86400000;
  const map = {
    overdue: { stage: 1, dueAt: t0 + 1 * 86400000, lastAt: t0 },
    future: { stage: 3, dueAt: t0 + 30 * 86400000, lastAt: t0 },
    exactly: { stage: 1, dueAt: now, lastAt: t0 }
  };
  const due = M.dueForReview(map, now);
  ok("筛出已到期题目", due.includes("overdue"));
  ok("筛出恰好到期的题目", due.includes("exactly"));
  ok("排除未到期题目", !due.includes("future"));
  ok("到期列表按时间升序", due[0] === "overdue", `实际顺序 ${due.join(",")}`);
}

/* ============================================================
   三、服务端并发同步（核心回归）
   ============================================================ */
async function testServerSync() {
  console.log("\n【三】服务端多设备同步（回归核心）");

  const uname = "sync_" + Date.now().toString(36);
  const reg = await req("POST", "/api/register", {
    body: { username: uname, password: "sync123456", nickname: "同步测试" }
  });
  const tokenA = reg.body.token;
  // 第二台设备：同账号再次登录
  const loginB = await req("POST", "/api/login", { body: { username: uname, password: "sync123456" } });
  const tokenB = loginB.body.token;
  ok("同一账号建立两个独立会话", tokenA !== tokenB);

  /* --- 场景 1：经典丢数据场景（修复前必失败） --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });

    // 设备 A 答对 q-A 并整体提交
    await req("PUT", "/api/progress", { token: tokenA, body: { progress: withRecord("q-A", true, 1000) } });
    // 设备 B 基于「不含 q-A」的旧视图，提交 q-B
    await req("PUT", "/api/progress", { token: tokenB, body: { progress: withRecord("q-B", false, 2000) } });

    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("【关键】设备 A 的记录未被设备 B 覆盖", !!after.records["q-A"],
      `records=${JSON.stringify(Object.keys(after.records))}`);
    ok("设备 B 的记录也保留", !!after.records["q-B"]);
    ok("设备 B 的错题保留", !!after.wrong["q-B"]);
  }

  /* --- 场景 2：交换提交顺序，结果一致 --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });
    // 顺序：B 先，A 后
    await req("PUT", "/api/progress", { token: tokenB, body: { progress: withRecord("q-B", false, 2000) } });
    await req("PUT", "/api/progress", { token: tokenA, body: { progress: withRecord("q-A", true, 1000) } });
    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("交换提交顺序后两端记录仍在", !!after.records["q-A"] && !!after.records["q-B"]);
  }

  /* --- 场景 3：高频交替提交（模拟真实刷题） --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });

    const devA = ["a1", "a2", "a3", "a4", "a5"];
    const devB = ["b1", "b2", "b3", "b4", "b5"];

    // 两台设备交替提交，每次只带自己已知的记录
    const localA = emptyP(), localB = emptyP();
    for (let i = 0; i < 5; i++) {
      localA.records[devA[i]] = { attempts: 1, correct: 1, wrong: 0, lastResult: "correct", lastAt: 1000 + i };
      await req("PUT", "/api/progress", { token: tokenA, body: { progress: localA } });

      localB.records[devB[i]] = { attempts: 1, correct: 0, wrong: 1, lastResult: "wrong", lastAt: 2000 + i };
      localB.wrong[devB[i]] = { addedAt: 2000 + i, count: 1, cleared: false };
      await req("PUT", "/api/progress", { token: tokenB, body: { progress: localB } });
    }

    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    const lostA = devA.filter(id => !after.records[id]);
    const lostB = devB.filter(id => !after.records[id]);
    ok("交替提交后设备 A 的 5 条记录零丢失", lostA.length === 0, `丢失：${lostA.join(",")}`);
    ok("交替提交后设备 B 的 5 条记录零丢失", lostB.length === 0, `丢失：${lostB.join(",")}`);
    ok("交替提交后错题本保留 5 题", Object.keys(after.wrong).length === 5,
      `实际 ${Object.keys(after.wrong).length}`);
  }

  /* --- 场景 4：并发提交（真正的同时） --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });

    const jobs = [];
    for (let i = 0; i < 10; i++) {
      const tk = i % 2 === 0 ? tokenA : tokenB;
      const p = emptyP();
      p.records["c" + i] = { attempts: 1, correct: 1, wrong: 0, lastResult: "correct", lastAt: 3000 + i };
      jobs.push(req("PUT", "/api/progress", { token: tk, body: { progress: p } }));
    }
    await Promise.all(jobs);

    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    const lost = [];
    for (let i = 0; i < 10; i++) if (!after.records["c" + i]) lost.push(i);
    ok("10 个并发提交零丢失", lost.length === 0, `丢失：${lost.join(",")}`);
  }

  /* --- 场景 5：增量上报路径 --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });
    await req("POST", "/api/progress/answer", { token: tokenA, body: { questionId: "inc-A", correct: true } });
    await req("POST", "/api/progress/answer", { token: tokenB, body: { questionId: "inc-B", correct: false } });
    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("增量上报：两端记录都保留", !!after.records["inc-A"] && !!after.records["inc-B"]);
    ok("增量上报：错题本正确", !!after.wrong["inc-B"]);
  }

  /* --- 场景 6：增量与整体 PUT 混用 --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });
    await req("POST", "/api/progress/answer", { token: tokenA, body: { questionId: "mix-1", correct: true } });
    await req("PUT", "/api/progress", { token: tokenB, body: { progress: withRecord("mix-2", true, 4000) } });
    await req("POST", "/api/progress/answer", { token: tokenB, body: { questionId: "mix-3", correct: true } });
    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("混用两种接口零丢失",
      !!after.records["mix-1"] && !!after.records["mix-2"] && !!after.records["mix-3"],
      `records=${JSON.stringify(Object.keys(after.records))}`);
  }

  /* --- 场景 7：计数只增不减 --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });
    await req("POST", "/api/progress/answer", { token: tokenA, body: { questionId: "cnt", correct: true } });
    await req("POST", "/api/progress/answer", { token: tokenA, body: { questionId: "cnt", correct: true } });
    const mid = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    const midAttempts = mid.records["cnt"].attempts;

    // 提交一份「旧」的、attempts 更少的快照，不应把计数拉低
    const stale = emptyP();
    stale.records["cnt"] = { attempts: 1, correct: 1, wrong: 0, lastResult: "correct", lastAt: 1 };
    await req("PUT", "/api/progress", { token: tokenB, body: { progress: stale } });

    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("提交陈旧快照不会拉低答题次数", after.records["cnt"].attempts >= midAttempts,
      `${midAttempts} → ${after.records["cnt"].attempts}`);
  }

  /* --- 场景 8：review 随答题推进并可跨设备同步 --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });
    await req("POST", "/api/progress/answer", { token: tokenA, body: { questionId: "rev-1", correct: true } });
    const after = (await req("GET", "/api/progress", { token: tokenB })).body.progress;
    ok("review 调度已写入并可跨设备读取", !!after.review["rev-1"], `review=${JSON.stringify(after.review)}`);
    ok("review 含 stage 与 dueAt", after.review["rev-1"].stage >= 0 && after.review["rev-1"].dueAt > 0);
  }

  /* --- 场景 9：清空进度仍然有效 --- */
  {
    await req("POST", "/api/progress/answer", { token: tokenA, body: { questionId: "clr", correct: true } });
    await req("DELETE", "/api/progress", { token: tokenA });
    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("清空进度后记录为空", Object.keys(after.records).length === 0);
  }

  /* --- 场景 10：用户隔离不被合并逻辑破坏 --- */
  {
    const other = "sync2_" + Date.now().toString(36);
    const r2 = await req("POST", "/api/register", { body: { username: other, password: "sync123456" } });
    const t2 = r2.body.token;
    await req("PUT", "/api/progress", { token: t2, body: { progress: withRecord("other-q", true, 9000) } });

    const mine = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("他人进度不会合并进我的账户", !mine.records["other-q"]);
  }

  /* --- 场景 11：笔记跨设备同步（LWW） --- */
  {
    await req("DELETE", "/api/progress", { token: tokenA });

    // 设备 A 写笔记
    const pA = emptyP();
    pA.notes["n-1"] = { text: "A端笔记", updatedAt: 1000, createdAt: 1000 };
    await req("PUT", "/api/progress", { token: tokenA, body: { progress: pA } });

    // 设备 B 写同题更新的笔记
    const pB = emptyP();
    pB.notes["n-1"] = { text: "B端更新", updatedAt: 2000, createdAt: 1000 };
    await req("PUT", "/api/progress", { token: tokenB, body: { progress: pB } });

    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("笔记跨设备同步取较新版本", after.notes["n-1"] && after.notes["n-1"].text === "B端更新",
      `实际 ${JSON.stringify(after.notes["n-1"])}`);
  }

  /* --- 场景 12：笔记超长被截断（防异常数据） --- */
  {
    const p = emptyP();
    p.notes["n-long"] = { text: "x".repeat(9999), updatedAt: 3000, createdAt: 3000 };
    await req("PUT", "/api/progress", { token: tokenA, body: { progress: p } });
    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    const len = (after.notes["n-long"] || {}).text.length;
    ok("服务端截断超长笔记", len <= 2000, `实际长度 ${len}`);
  }

  /* --- 场景 13：笔记删除意图可同步 --- */
  {
    const p = emptyP();
    p.notes["n-1"] = { text: "", updatedAt: 5000, createdAt: 1000 };
    await req("PUT", "/api/progress", { token: tokenB, body: { progress: p } });
    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("空笔记（删除）能同步到另一端",
      after.notes["n-1"] && after.notes["n-1"].text === "",
      `实际 ${JSON.stringify(after.notes["n-1"])}`);
  }

  /* --- 场景 14：每日目标跨设备同步 --- */
  {
    const pA = emptyP();
    pA.goals = { dailyQuestions: 25, dailyMinutes: 0, updatedAt: 1000 };
    await req("PUT", "/api/progress", { token: tokenA, body: { progress: pA } });

    const pB = emptyP();
    pB.goals = { dailyQuestions: 50, dailyMinutes: 30, updatedAt: 2000 };
    await req("PUT", "/api/progress", { token: tokenB, body: { progress: pB } });

    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("目标跨设备同步取较新配置", after.goals.dailyQuestions === 50,
      `实际 ${after.goals.dailyQuestions}`);
    ok("目标时长同步正确", after.goals.dailyMinutes === 30,
      `实际 ${after.goals.dailyMinutes}`);
  }

  /* --- 场景 15：目标数值越界被钳制 --- */
  {
    const p = emptyP();
    p.goals = { dailyQuestions: 99999, dailyMinutes: -50, updatedAt: 9000 };
    await req("PUT", "/api/progress", { token: tokenA, body: { progress: p } });
    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("目标题量上限被钳制", after.goals.dailyQuestions <= 500,
      `实际 ${after.goals.dailyQuestions}`);
    ok("目标时长下限被钳制", after.goals.dailyMinutes >= 0,
      `实际 ${after.goals.dailyMinutes}`);
  }

  /* --- 场景 16：非法 notes/goals 结构不导致崩溃 --- */
  {
    const bad = await req("PUT", "/api/progress", {
      token: tokenA,
      body: { progress: { notes: "not-an-object", goals: 12345, records: "bad" } }
    });
    ok("非法 notes/goals 结构被安全处理", bad.status === 200, `status=${bad.status}`);

    const after = (await req("GET", "/api/progress", { token: tokenA })).body.progress;
    ok("非法结构退化为空对象", typeof after.notes === "object" && typeof after.goals === "object");
  }
}

/* ============================================================
   执行
   ============================================================ */
server.listen(PORT, async () => {
  console.log("=".repeat(64));
  console.log("P0 回归测试 —— 多设备同步零丢失");
  console.log("=".repeat(64));

  try {
    testMergeAlgebra();
    testReviewScheduler();
    await testServerSync();
  } catch (e) {
    fail++;
    problems.push("执行异常：" + e.message + "\n" + (e.stack || "").split("\n").slice(1, 4).join("\n"));
  }

  console.log("\n" + "=".repeat(64));
  console.log(`通过：${pass}    失败：${fail}`);
  if (problems.length) {
    console.log("\n✗ 失败项：");
    problems.forEach(p => console.log("  - " + p));
  } else {
    console.log("\n✓ 多设备同步零丢失：交换律、幂等性、并发提交、混用接口均已验证。");
  }
  console.log("=".repeat(64));

  try { fs.rmSync(TEST_DATA, { recursive: true, force: true }); } catch {}
  server.close(() => process.exit(fail ? 1 : 0));
});
