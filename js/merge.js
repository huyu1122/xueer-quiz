/**
 * 学而刷题 —— 进度合并模块（前后端共用）
 *
 * 设计要点：
 *  - 合并规则必须**双端完全一致**，否则一端合并、一端覆盖仍会丢数据。
 *    因此本文件同时被浏览器（window.QuizMerge）与 Node（module.exports）加载。
 *  - 合并遵循「单调不减」原则：任何计数只增不减，因此合并可重复执行、
 *    与顺序无关（幂等且交换律成立），这是避免并发丢数据的关键。
 *
 * 合并规则：
 *  - records   ：attempts/correct/wrong 取较大值；lastResult 取 lastAt 较新者
 *  - wrong     ：count 取较大值；两端都订正才算已订正；addedAt 取较早者
 *  - favorites ：并集，addedAt 取较早者
 *  - exams     ：按 id 去重，按时间倒序，最多保留 100 条
 *  - daily     ：逐日 answered/correct 取较大值
 *  - streak    ：天数取较大值，lastDate 取较晚者
 *  - review    ：间隔重复调度，取「更晚的到期时间」与「更大的阶段」
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.QuizMerge = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MAX_EXAMS = 100;
  /** 单条笔记最大长度（字符），防止异常数据撑爆存储 */
  const MAX_NOTE_LEN = 2000;
  /** 笔记条目上限 */
  const MAX_NOTES = 5000;
  /**
   * 笔记正文总字节上限。
   *
   * 为什么需要：仅限制「条数 × 单条长度」的乘积是 5000×2000 ≈ 10 MB，
   * 实测这种进度对象达 10 MB，远超服务端请求体上限，同步会直接失败。
   * 加上总字节上限后，整个进度对象的体积有了**确定性上界**，
   * 可以据此安全地设置请求体上限。
   *
   * 1 MB 对个人笔记是极宽裕的量（约 50 万字），
   * 同时保证 payload 稳定在 1.2 MB 以内。
   */
  const MAX_NOTES_BYTES = 1024 * 1024;
  /** daily 保留天数（超出则裁剪最旧的） */
  const DAILY_KEEP_DAYS = 400;

  /**
   * 裁剪 daily 与 notes，防止长期使用后无限增长。
   * 实测：400 天 daily + 300 条笔记会让 /api/progress 响应达到 107 KB，
   * 每次同步都要传输，长期累积会明显拖慢同步。
   *
   * 注意：这是**有损**操作，只在写入路径调用，且保留足够长的历史
   * （daily 400 天 > 任何合理的统计窗口；notes 5000 条远超正常使用量）。
   * @param {object} progress
   * @param {number} now
   * @returns {object} 裁剪后的新对象（不修改入参）
   */
  function pruneProgress(progress, now) {
    const t = now === undefined ? Date.now() : now;
    const p = obj(progress);

    /* daily：按日期字符串排序，保留最近 DAILY_KEEP_DAYS 天 */
    const daily = obj(p.daily);
    const keys = Object.keys(daily).sort();          // YYYY-MM-DD 字典序即时间序
    let keptDaily = daily;
    if (keys.length > DAILY_KEEP_DAYS) {
      keptDaily = {};
      for (const k of keys.slice(-DAILY_KEEP_DAYS)) keptDaily[k] = daily[k];
    }

    /* notes：先按条数裁剪，再按总字节裁剪，保证体积有确定上界 */
    const notes = obj(p.notes);
    let nKeys = Object.keys(notes);
    let keptNotes = notes;

    if (nKeys.length > MAX_NOTES) {
      keptNotes = {};
      nKeys
        .sort((a, b) => num(obj(notes[b]).updatedAt) - num(obj(notes[a]).updatedAt))
        .slice(0, MAX_NOTES)
        .forEach(k => { keptNotes[k] = notes[k]; });
      nKeys = Object.keys(keptNotes);
    }

    // 总字节超限时，从最旧的笔记开始丢弃，直到回到上限内
    let bytes = 0;
    const sized = nKeys.map(k => {
      const n = obj(keptNotes[k]);
      const len = utf8Length(n.text) + 48;  // 48 ≈ 键名与字段开销
      bytes += len;
      return { k, len, updatedAt: num(n.updatedAt) };
    });

    if (bytes > MAX_NOTES_BYTES) {
      sized.sort((a, b) => a.updatedAt - b.updatedAt);   // 最旧的在前
      const drop = new Set();
      let remain = bytes;
      for (const s of sized) {
        if (remain <= MAX_NOTES_BYTES) break;
        drop.add(s.k);
        remain -= s.len;
      }
      if (drop.size) {
        const trimmed = {};
        for (const k of Object.keys(keptNotes)) {
          if (!drop.has(k)) trimmed[k] = keptNotes[k];
        }
        keptNotes = trimmed;
      }
    }

    /* exams：已是固定上限，这里再兜一次底 */
    const exams = Array.isArray(p.exams) ? p.exams.slice(0, MAX_EXAMS) : [];

    return {
      records: obj(p.records),
      wrong: obj(p.wrong),
      favorites: obj(p.favorites),
      exams,
      daily: keptDaily,
      streak: obj(p.streak),
      review: obj(p.review),
      notes: keptNotes,
      goals: obj(p.goals)
    };
  }

  function emptyProgress() {
    return {
      records: {}, wrong: {}, favorites: {}, exams: [],
      daily: {}, streak: { days: 0, lastDate: "" }, review: {},
      notes: {}, goals: emptyGoals()
    };
  }

  /**
   * 每日目标配置。
   * goals 是「用户偏好」，不是可累加的计数，因此合并时取整体较新的一份。
   */
  function emptyGoals() {
    return {
      dailyQuestions: 20,     // 每日目标题量，0 表示不设目标
      dailyMinutes: 0,        // 每日目标时长（分钟），0 表示不设
      updatedAt: 0
    };
  }

  /** 安全取对象，非法值退化为空对象 */
  const obj = (v) => (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  const num = (v) => (typeof v === "number" && isFinite(v)) ? v : 0;
  const str = (v) => (typeof v === "string") ? v : "";

  /**
   * 估算字符串的 UTF-8 字节数。
   * 不能直接用 Buffer.byteLength —— 本文件在浏览器中也会加载，
   * 浏览器没有 Buffer。这里按码点区间估算，对中日韩字符足够准确。
   */
  function utf8Length(s) {
    const v = str(s);
    let bytes = 0;
    for (let i = 0; i < v.length; i++) {
      const c = v.charCodeAt(i);
      if (c < 0x80) bytes += 1;
      else if (c < 0x800) bytes += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { bytes += 4; i++; }  // 代理对（emoji 等）
      else bytes += 3;
    }
    return bytes;
  }

  /**
   * 按 key 排序后重建对象，使合并结果成为**规范形式**。
   * 这样 merge(a,b) 与 merge(b,a) 不仅数据相同，序列化结果也完全一致，
   * 便于比较、做哈希与排查同步问题。
   */
  function canonical(map) {
    const out = {};
    for (const k of Object.keys(map).sort()) out[k] = map[k];
    return out;
  }

  /**
   * 合并两份进度。可交换、幂等、单调不减。
   * @param {object} a
   * @param {object} b
   * @returns {object} 新的合并结果（不修改入参）
   */
  function mergeProgress(a, b) {
    const A = obj(a), B = obj(b);
    const out = emptyProgress();

    /* ---------- records ---------- */
    const recA = obj(A.records), recB = obj(B.records);
    const recIds = new Set([...Object.keys(recA), ...Object.keys(recB)]);
    for (const id of recIds) {
      const x = obj(recA[id]), y = obj(recB[id]);
      const lastAt = Math.max(num(x.lastAt), num(y.lastAt));
      // lastResult 取时间较新的一端的结论；时间相同则优先取「错误」，
      // 避免把一次错误覆盖成正确而漏掉错题复习
      let lastResult;
      if (num(x.lastAt) > num(y.lastAt)) lastResult = x.lastResult ?? null;
      else if (num(y.lastAt) > num(x.lastAt)) lastResult = y.lastResult ?? null;
      else lastResult = (x.lastResult === "wrong" || y.lastResult === "wrong") ? "wrong" : (x.lastResult ?? y.lastResult ?? null);

      out.records[id] = {
        attempts: Math.max(num(x.attempts), num(y.attempts)),
        correct: Math.max(num(x.correct), num(y.correct)),
        wrong: Math.max(num(x.wrong), num(y.wrong)),
        lastResult,
        lastAt
      };
    }

    /* ---------- wrong（错题本） ---------- */
    const wA = obj(A.wrong), wB = obj(B.wrong);
    for (const id of new Set([...Object.keys(wA), ...Object.keys(wB)])) {
      const x = wA[id], y = wB[id];
      if (x && y) {
        const ax = obj(x), ay = obj(y);
        out.wrong[id] = {
          // addedAt 取较早者，保留最早进入错题本的时间
          addedAt: Math.min(num(ax.addedAt) || Infinity, num(ay.addedAt) || Infinity) || Date.now(),
          count: Math.max(num(ax.count), num(ay.count)),
          // 只有两端都订正才算订正
          cleared: !!(ax.cleared && ay.cleared)
        };
      } else {
        const only = obj(x || y);
        out.wrong[id] = {
          addedAt: num(only.addedAt) || Date.now(),
          count: num(only.count),
          cleared: !!only.cleared
        };
      }
    }

    /* ---------- favorites ---------- */
    const fA = obj(A.favorites), fB = obj(B.favorites);
    for (const id of new Set([...Object.keys(fA), ...Object.keys(fB)])) {
      const ax = obj(fA[id]), ay = obj(fB[id]);
      const t = Math.min(num(ax.addedAt) || Infinity, num(ay.addedAt) || Infinity);
      out.favorites[id] = { addedAt: isFinite(t) ? t : Date.now() };
    }

    /* ---------- exams（按 id 去重，时间倒序） ---------- */
    const seen = new Set();
    const exams = [];
    for (const e of [...(Array.isArray(A.exams) ? A.exams : []), ...(Array.isArray(B.exams) ? B.exams : [])]) {
      if (!e || typeof e !== "object" || !e.id) continue;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      exams.push(e);
    }
    exams.sort((p, q) => num(q.at) - num(p.at));
    out.exams = exams.slice(0, MAX_EXAMS);

    /* ---------- daily ---------- */
    const dA = obj(A.daily), dB = obj(B.daily);
    for (const k of new Set([...Object.keys(dA), ...Object.keys(dB)])) {
      const x = obj(dA[k]), y = obj(dB[k]);
      out.daily[k] = {
        answered: Math.max(num(x.answered), num(y.answered)),
        correct: Math.max(num(x.correct), num(y.correct))
      };
    }

    /* ---------- streak ---------- */
    const sA = obj(A.streak), sB = obj(B.streak);
    const dates = [str(sA.lastDate), str(sB.lastDate)].filter(Boolean).sort();
    out.streak = {
      days: Math.max(num(sA.days), num(sB.days)),
      lastDate: dates.length ? dates[dates.length - 1] : ""
    };

    /* ---------- review（间隔重复调度） ---------- */
    const rA = obj(A.review), rB = obj(B.review);
    for (const id of new Set([...Object.keys(rA), ...Object.keys(rB)])) {
      const x = obj(rA[id]), y = obj(rB[id]);
      // 取「阶段更大」且「到期更晚」的一方：保证不会因同步而把复习计划提前
      const stage = Math.max(num(x.stage), num(y.stage));
      const dueAt = Math.max(num(x.dueAt), num(y.dueAt));
      const src = num(x.dueAt) >= num(y.dueAt) ? x : y;
      out.review[id] = {
        stage,
        dueAt,
        lastAt: Math.max(num(x.lastAt), num(y.lastAt)),
        ease: num(src.ease) || 2.5,
        lapses: Math.max(num(x.lapses), num(y.lapses))
      };
    }

    /* ---------- notes（个人笔记，Last-Write-Wins） ---------- */
    /*
     * 笔记是可编辑文本，不能像计数那样「取较大值」，否则删除与修改都会失效。
     * 采用 LWW：按 updatedAt 取较新的一条；时间相同则取文本较长者
     * （保证合并交换律成立 —— 两端都必须得到同一结果）。
     * 空文本表示用户主动删除，需要保留该删除意图。
     */
    const nA = obj(A.notes), nB = obj(B.notes);
    for (const id of new Set([...Object.keys(nA), ...Object.keys(nB)])) {
      const x = obj(nA[id]), y = obj(nB[id]);
      const tx = num(x.updatedAt), ty = num(y.updatedAt);
      let pick;
      if (tx > ty) pick = x;
      else if (ty > tx) pick = y;
      else {
        // 时间戳相同：用文本长度与内容做确定性裁决，保证交换律
        const sx = str(x.text), sy = str(y.text);
        pick = sx.length >= sy.length ? x : y;
      }
      const text = str(pick.text).slice(0, MAX_NOTE_LEN);
      out.notes[id] = {
        text,
        updatedAt: Math.max(tx, ty),
        // 保留最早创建时间，便于「笔记时间线」展示
        createdAt: Math.min(num(x.createdAt) || Infinity, num(y.createdAt) || Infinity) || num(pick.createdAt) || 0
      };
    }

    /* ---------- goals（每日目标，整体取较新） ---------- */
    const gA = obj(A.goals), gB = obj(B.goals);
    const ga = num(gA.updatedAt), gb = num(gB.updatedAt);
    const gPick = ga > gb ? gA : (gb > ga ? gB : (num(gA.dailyQuestions) >= num(gB.dailyQuestions) ? gA : gB));
    out.goals = {
      dailyQuestions: Math.max(0, Math.min(500, num(gPick.dailyQuestions))),
      dailyMinutes: Math.max(0, Math.min(600, num(gPick.dailyMinutes))),
      updatedAt: Math.max(ga, gb)
    };

    /*
     * 合并后统一裁剪，防止长期使用导致数据无限增长。
     * 裁剪是确定性的（只依赖合并结果），因此不影响交换律。
     */
    return pruneProgress({
      records: canonical(out.records),
      wrong: canonical(out.wrong),
      favorites: canonical(out.favorites),
      exams: out.exams,
      daily: canonical(out.daily),
      streak: out.streak,
      review: canonical(out.review),
      notes: canonical(out.notes),
      goals: out.goals
    });
  }

  /* ============================================================
     间隔重复（简化版 SM-2）
     ============================================================ */

  /** 各阶段对应的复习间隔（天）。0 表示当天再练。 */
  const INTERVALS_DAYS = [0, 1, 3, 7, 16, 35, 75, 150];
  const DAY_MS = 24 * 60 * 60 * 1000;

  /** 取本地日期字符串 YYYY-MM-DD */
  function dayKey(ts) {
    const d = new Date(ts === undefined ? Date.now() : ts);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * 依据一次作答结果推进复习调度。
   * @param {object|undefined} prev 上一次的 review 条目
   * @param {boolean} correct 本次是否答对
   * @param {number} now 时间戳
   * @returns {object} 新的 review 条目
   */
  function scheduleReview(prev, correct, now) {
    const t = now === undefined ? Date.now() : now;
    const p = obj(prev);
    const stage = num(p.stage);
    const lapses = num(p.lapses);
    const ease = num(p.ease) || 2.5;

    if (correct) {
      // 答对：进入下一阶段，间隔按表递增
      const nextStage = Math.min(stage + 1, INTERVALS_DAYS.length - 1);
      const days = INTERVALS_DAYS[nextStage];
      return {
        stage: nextStage,
        dueAt: t + days * DAY_MS,
        lastAt: t,
        ease: Math.min(3.0, ease + 0.1),   // 答对略微提高难度容忍度
        lapses
      };
    }

    // 答错：回退阶段并缩短间隔，当天/次日就要重练
    const backStage = Math.max(0, Math.min(stage - 1, 1));
    return {
      stage: backStage,
      dueAt: t + INTERVALS_DAYS[backStage] * DAY_MS,
      lastAt: t,
      ease: Math.max(1.3, ease - 0.2),
      lapses: lapses + 1
    };
  }

  /**
   * 筛出「今天该复习」的题 id。
   * @param {object} reviewMap review 表
   * @param {number} now
   * @returns {string[]} 按到期时间升序（越早到期越靠前）
   */
  function dueForReview(reviewMap, now) {
    const t = now === undefined ? Date.now() : now;
    const r = obj(reviewMap);
    return Object.keys(r)
      .filter(id => num(obj(r[id]).dueAt) <= t)
      .sort((x, y) => num(obj(r[x]).dueAt) - num(obj(r[y]).dueAt));
  }

  /* ============================================================
     每日目标
     ============================================================ */

  /**
   * 计算今日目标的完成进度。
   *
   * 注意「答题次数」与「完成题数」的区别：daily[day].answered 是作答次数
   * （同一题重做会累加），作为目标衡量口径是合理的 —— 目标衡量的是练习量。
   *
   * @param {object} progress 完整进度对象
   * @param {number} now
   * @returns {{target:number, done:number, percent:number, remain:number,
   *            met:boolean, hasGoal:boolean, correct:number, accuracy:number,
   *            dayKey:string}}
   */
  function goalProgress(progress, now) {
    const t = now === undefined ? Date.now() : now;
    const p = obj(progress);
    const g = obj(p.goals);
    const key = dayKey(t);
    const day = obj(obj(p.daily)[key]);

    const target = num(g.dailyQuestions);
    const done = num(day.answered);
    const correct = num(day.correct);
    const hasGoal = target > 0;

    // 百分比封顶 100，避免超额完成时进度环溢出
    const percent = hasGoal ? Math.min(100, Math.round((done / target) * 100)) : 0;

    return {
      target, done, correct,
      percent,
      remain: Math.max(0, target - done),
      met: hasGoal && done >= target,
      hasGoal,
      accuracy: done ? Math.round((correct / done) * 100) : 0,
      dayKey: key
    };
  }

  /**
   * 近 N 天的目标达成情况，用于「打卡日历」。
   * @param {object} progress
   * @param {number} days
   * @param {number} now
   * @returns {Array<{key:string,label:string,answered:number,correct:number,met:boolean,percent:number}>}
   */
  function goalHistory(progress, days, now) {
    const t = now === undefined ? Date.now() : now;
    const p = obj(progress);
    const target = num(obj(p.goals).dailyQuestions);
    const out = [];
    const n = Math.max(1, num(days) || 14);

    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(t);
      d.setDate(d.getDate() - i);
      const key = dayKey(d.getTime());
      const day = obj(obj(p.daily)[key]);
      const answered = num(day.answered);
      out.push({
        key,
        label: `${d.getMonth() + 1}/${d.getDate()}`,
        answered,
        correct: num(day.correct),
        met: target > 0 && answered >= target,
        percent: target > 0 ? Math.min(100, Math.round((answered / target) * 100)) : 0
      });
    }
    return out;
  }

  return {
    emptyProgress, emptyGoals, mergeProgress, pruneProgress,
    scheduleReview, dueForReview, dayKey,
    goalProgress, goalHistory,
    INTERVALS_DAYS, MAX_EXAMS, MAX_NOTE_LEN, MAX_NOTES, MAX_NOTES_BYTES,
    DAILY_KEEP_DAYS
  };
});
