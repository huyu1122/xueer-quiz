/**
 * 学而刷题 —— 数据层
 * 本地 localStorage 为主存储；登录后与服务端双向同步。
 *
 * 同步策略（修复多设备丢数据的关键）：
 *  1. 答题走**增量上报** POST /api/progress/answer —— 服务端做加法，天然无覆盖问题
 *  2. 结构性变更（收藏、删错题、导入）走 PUT，但服务端**合并**而非覆盖
 *  3. 上报失败进入重试队列，恢复后自动补发，避免离线作答丢失
 *  4. 合并规则与后端共用 js/merge.js，双端一致
 */
const Store = (() => {
  const KEY = "xueer-quiz-v1";
  const QUEUE_KEY = "xueer-pending-v1";
  const M = window.QuizMerge;

  const defaultData = () => {
    const base = M.emptyProgress();
    return {
      ...base,
      settings: {
        theme: "light",
        instantJudge: true,
        autoNext: false,
        fontSize: "md"
      }
    };
  };
  /**
   * 判断是否为「普通对象」（排除 null 与数组）。
   *
   * 注意：必须定义在 load() **之前**。
   * const 箭头函数不提升，若定义在使用之后会触发
   * "Cannot access before initialization"（暂时性死区）。
   * 该错误曾被 load() 的 try/catch 吞掉而表现为「静默重置」，
   * 因此格外隐蔽 —— 由 test/robust.test.js 捕获。
   */
  const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

  let data = load();
  let currentUser = null;
  let syncState = "idle";
  let syncTimer = null;
  const syncListeners = new Set();

  /* 待补发的增量上报队列：[{questionId, correct, at}] */
  let pending = loadQueue();

  /**
   * 从 localStorage 载入数据。
   *
   * 关键：**必须逐字段校验类型**，不能只做浅合并。
   *
   * 踩过的坑：早期实现用 `{ ...base, ...parsed }`，若本地数据里
   * `records` 是数组、`wrong` 是 null（可能来自旧版本、手工编辑、
   * 或写入中断），这些**非法值会覆盖掉默认的空对象**，
   * 随后 `Object.keys(records)` 抛 TypeError，
   * 导致首页渲染中断、**题目全部消失**（页面只剩 18 个字符）。
   *
   * 现在对每个字段独立校验：类型不符则回退到默认值，
   * 从而「坏一个字段」不会拖垮整个应用。
   */
  function load() {
    const base = defaultData();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return base;

      const parsed = JSON.parse(raw);
      if (!isPlainObject(parsed)) return base;   // null / 数组 / 原始值一律重置

      /** 对象字段：非普通对象则用默认值 */
      const pickObj = (key) => isPlainObject(parsed[key]) ? parsed[key] : base[key];
      /** 数组字段：非数组则用默认值 */
      const pickArr = (key) => Array.isArray(parsed[key]) ? parsed[key] : base[key];

      return {
        records: pickObj("records"),
        wrong: pickObj("wrong"),
        favorites: pickObj("favorites"),
        exams: pickArr("exams"),
        daily: pickObj("daily"),
        streak: isPlainObject(parsed.streak) ? { ...base.streak, ...parsed.streak } : base.streak,
        review: pickObj("review"),
        notes: pickObj("notes"),
        goals: isPlainObject(parsed.goals) ? { ...base.goals, ...parsed.goals } : base.goals,
        settings: isPlainObject(parsed.settings) ? { ...base.settings, ...parsed.settings } : base.settings
      };
    } catch (e) {
      console.warn("读取本地数据失败，已重置", e);
      return base;
    }
  }

  function loadQueue() {
    try {
      const raw = localStorage.getItem(QUEUE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }

  function saveQueue() {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(pending.slice(0, 500))); }
    catch { /* 忽略 */ }
  }

  function save() {
    // 超限时先裁剪，避免 localStorage 配额溢出与超大同步 payload
    try { maybePrune(); } catch { /* 裁剪失败不影响保存 */ }

    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch (e) {
      // 配额溢出时，尝试裁剪后重试一次
      try {
        M.pruneProgress(data, Date.now());
        data.exams = data.exams.slice(0, 50);
        localStorage.setItem(KEY, JSON.stringify(data));
        console.warn("localStorage 接近配额，已裁剪历史数据");
      } catch (e2) {
        console.warn("保存失败（可能是隐私模式或空间不足）", e);
      }
    }
    // 数据变了，统计缓存失效
    statsCache = null;
  }

  /**
   * 统计结果缓存。
   *
   * 为什么需要：一次渲染会多次调用 stats()（页脚、首页卡片、导航角标），
   * 每次都要遍历全部 records。实测在 100 题、多次作答后，
   * 单次渲染重复计算 3 次以上。缓存后只在数据变化时重算一次。
   *
   * 失效点统一放在 save()：所有写操作都会经过它，不易漏掉。
   */
  let statsCache = null;

  const todayKey = () => M.dayKey();

  /* ============================================================
     同步状态
     ============================================================ */
  function setSyncState(s) {
    syncState = s;
    syncListeners.forEach(fn => { try { fn(s); } catch { /* 忽略 */ } });
  }

  /**
   * 在数据超限时裁剪本地数据。
   *
   * 为什么需要：服务端虽然会裁剪，但本地数据若无界增长，
   * 一是会超出 localStorage 配额（约 5 MB），
   * 二是同步时上传的 payload 会超过服务端请求体上限导致同步失败。
   *
   * 先用廉价的长度检查，只有确实超限才付出排序成本。
   * @returns {boolean} 是否执行了裁剪
   */
  function maybePrune() {
    const overDaily = Object.keys(data.daily).length > M.DAILY_KEEP_DAYS;
    const overNotes = Object.keys(data.notes).length > M.MAX_NOTES;
    if (!overDaily && !overNotes) return false;

    const pruned = M.pruneProgress(data, Date.now());
    data.daily = pruned.daily;
    data.notes = pruned.notes;
    data.exams = pruned.exams;
    return true;
  }

  function syncPayload() {
    return {
      records: data.records,
      wrong: data.wrong,
      favorites: data.favorites,
      exams: data.exams,
      daily: data.daily,
      streak: data.streak,
      review: data.review,
      notes: data.notes,
      goals: data.goals
    };
  }

  /** 防抖推送结构变更（服务端会合并，不会覆盖） */
  function scheduleSync(delay = 900) {
    if (!currentUser || !window.Api) return;
    clearTimeout(syncTimer);
    setSyncState("saving");
    syncTimer = setTimeout(async () => {
      try {
        await flushPending();                       // 先补发积压的增量
        await window.Api.saveProgress(syncPayload()); // 再合并结构变更
        setSyncState("saved");
      } catch (e) {
        console.warn("进度同步失败，稍后重试", e);
        setSyncState("error");
      }
    }, delay);
  }

  /** 逐条补发增量上报；失败的留在队列里下次再试 */
  async function flushPending() {
    if (!currentUser || !window.Api || !pending.length) return;
    const remain = [];
    for (const item of pending) {
      try {
        await window.Api.reportAnswer(item.questionId, item.correct);
      } catch {
        remain.push(item);   // 保留，下次重试
      }
    }
    pending = remain;
    saveQueue();
  }

  /**
   * 上报一次作答。优先直连服务端；失败则入队，等恢复后补发。
   * 这是替代「整体 PUT」的关键路径，避免并发覆盖。
   */
  async function reportAnswer(qid, correct) {
    if (!currentUser || !window.Api) return;
    setSyncState("saving");
    try {
      await window.Api.reportAnswer(qid, correct);
      // 顺带把积压的补发掉
      if (pending.length) await flushPending();
      setSyncState(pending.length ? "error" : "saved");
    } catch {
      pending.push({ questionId: qid, correct, at: Date.now() });
      saveQueue();
      setSyncState("error");
    }
  }

  /* ============================================================
     公开接口
     ============================================================ */
  return {
    get data() { return data; },
    get user() { return currentUser; },
    get syncState() { return syncState; },
    get pendingCount() { return pending.length; },
    save, todayKey,
    mergeProgress: M.mergeProgress,
    scheduleReview: M.scheduleReview,
    dueForReview: M.dueForReview,

    onSync(fn) { syncListeners.add(fn); return () => syncListeners.delete(fn); },

    /* ---------- 登录 / 登出 ---------- */
    async attachUser(user) {
      currentUser = user;
      let remoteHadData = false;
      try {
        const remote = await window.Api.fetchProgress();
        remoteHadData = Object.keys(remote.records || {}).length > 0
          || Object.keys(remote.wrong || {}).length > 0
          || (remote.exams || []).length > 0;

        // 先补发本地积压（可能来自上次离线作答），再合并
        await flushPending();

        const merged = M.mergeProgress(syncPayload(), remote);
        data.records = merged.records;
        data.wrong = merged.wrong;
        data.favorites = merged.favorites;
        data.exams = merged.exams;
        data.daily = merged.daily;
        data.streak = merged.streak;
        data.review = merged.review;
        data.notes = merged.notes;
        data.goals = merged.goals;
        save();

        // 服务端也会合并，双保险
        await window.Api.saveProgress(syncPayload());
        setSyncState("saved");
        return { merged: true, remoteHadData };
      } catch (e) {
        console.warn("拉取服务端进度失败", e);
        setSyncState("error");
        return { merged: false, remoteHadData };
      }
    },

    detachUser() {
      currentUser = null;
      clearTimeout(syncTimer);
      setSyncState("idle");
    },

    async syncNow() {
      if (!currentUser) return false;
      setSyncState("saving");
      try {
        await flushPending();
        await window.Api.saveProgress(syncPayload());
        setSyncState(pending.length ? "error" : "saved");
        return pending.length === 0;
      } catch {
        setSyncState("error");
        return false;
      }
    },

    /* ---------- 设置 ---------- */
    settings() { return data.settings; },
    setSetting(k, v) { data.settings[k] = v; save(); },

    /* ---------- 答题记录 ---------- */
    recordAnswer(qid, isCorrect) {
      const r = data.records[qid] || { attempts: 0, correct: 0, wrong: 0, lastResult: null, lastAt: 0 };
      r.attempts += 1;
      if (isCorrect) { r.correct += 1; r.lastResult = "correct"; }
      else { r.wrong += 1; r.lastResult = "wrong"; }
      r.lastAt = Date.now();
      data.records[qid] = r;

      const dk = todayKey();
      const d = data.daily[dk] || { answered: 0, correct: 0 };
      d.answered += 1;
      if (isCorrect) d.correct += 1;
      data.daily[dk] = d;

      if (data.streak.lastDate !== dk) {
        const y = new Date(); y.setDate(y.getDate() - 1);
        const yk = M.dayKey(y.getTime());
        data.streak.days = data.streak.lastDate === yk ? data.streak.days + 1 : 1;
        data.streak.lastDate = dk;
      }

      if (!isCorrect) this.addWrong(qid); else this.markWrongCorrect(qid);

      // 推进间隔重复调度
      data.review[qid] = M.scheduleReview(data.review[qid], isCorrect, r.lastAt);

      save();
      // 关键：走增量上报，不再整体覆盖
      reportAnswer(qid, isCorrect);
    },

    getRecord(qid) { return data.records[qid] || null; },
    getReview(qid) { return data.review[qid] || null; },

    /** 今日待复习题目 id 列表（按到期时间升序） */
    dueList() { return M.dueForReview(data.review, Date.now()); },

    /**
     * 今日待复习数量。
     * 直接计数而**不调用 dueList**：dueList 会做一次排序，
     * 而计数只需要过滤。导航角标与首页都会调用它，省掉排序是可观的。
     */
    dueCount() {
      const now = Date.now();
      let n = 0;
      for (const id in data.review) {
        const r = data.review[id];
        if (r && r.dueAt <= now) n++;
      }
      return n;
    },

    /* ---------- 错题本 ---------- */
    addWrong(qid) {
      const w = data.wrong[qid] || { addedAt: Date.now(), count: 0, cleared: false };
      w.count += 1; w.cleared = false; w.addedAt = Date.now();
      data.wrong[qid] = w; save();
    },
    markWrongCorrect(qid) {
      const w = data.wrong[qid];
      if (!w) return;
      w.cleared = true;
      save();
    },
    removeWrong(qid) { delete data.wrong[qid]; delete data.review[qid]; save(); scheduleSync(); },
    clearWrong() { data.wrong = {}; save(); scheduleSync(); },
    wrongList() { return Object.keys(data.wrong); },
    wrongCount() { return Object.keys(data.wrong).length; },

    /* ---------- 收藏 ---------- */
    toggleFavorite(qid) {
      if (data.favorites[qid]) delete data.favorites[qid];
      else data.favorites[qid] = { addedAt: Date.now() };
      save();
      scheduleSync();
      return !!data.favorites[qid];
    },
    isFavorite(qid) { return !!data.favorites[qid]; },
    favoriteList() { return Object.keys(data.favorites); },
    favoriteCount() { return Object.keys(data.favorites).length; },

    /* ---------- 考试记录 ---------- */
    addExam(rec) {
      data.exams.unshift(rec);
      if (data.exams.length > M.MAX_EXAMS) data.exams.length = M.MAX_EXAMS;
      save();
      scheduleSync();
    },
    examList() { return data.exams; },

    /* ---------- 个人笔记 ---------- */
    /**
     * 保存某题的笔记。空文本表示删除该笔记
     * （保留一条空记录并更新时间戳，这样删除意图能同步到其他设备）。
     * @param {string} qid
     * @param {string} text
     */
    saveNote(qid, text) {
      const t = String(text ?? "").slice(0, M.MAX_NOTE_LEN);
      const prev = data.notes[qid];
      if (!t.trim() && !prev) return;   // 本来就没有笔记，无需写入空记录

      data.notes[qid] = {
        text: t,
        updatedAt: Date.now(),
        createdAt: prev ? (prev.createdAt || prev.updatedAt || Date.now()) : Date.now()
      };
      save();
      scheduleSync(400);   // 笔记是显式操作，尽快同步
    },

    getNote(qid) {
      const n = data.notes[qid];
      return n && n.text && n.text.trim() ? n : null;
    },

    /** 有内容的笔记列表（按更新时间倒序） */
    noteList() {
      return Object.keys(data.notes)
        .filter(id => {
          const n = data.notes[id];
          return n && n.text && n.text.trim();
        })
        .sort((a, b) => (data.notes[b].updatedAt || 0) - (data.notes[a].updatedAt || 0));
    },

    /** 有内容的笔记数量。直接计数，避免 noteList 的排序开销 */
    noteCount() {
      let n = 0;
      for (const id in data.notes) {
        const x = data.notes[id];
        if (x && x.text && x.text.trim()) n++;
      }
      return n;
    },

    deleteNote(qid) {
      if (!data.notes[qid]) return;
      delete data.notes[qid];
      save();
      scheduleSync(400);
    },

    /* ---------- 每日目标 ---------- */
    goals() { return { ...M.emptyGoals(), ...(data.goals || {}) }; },

    /**
     * 设置每日目标。
     * @param {{dailyQuestions?:number, dailyMinutes?:number}} patch
     */
    setGoals(patch) {
      const cur = this.goals();
      const next = {
        dailyQuestions: patch.dailyQuestions !== undefined
          ? Math.max(0, Math.min(500, Math.round(Number(patch.dailyQuestions) || 0)))
          : cur.dailyQuestions,
        dailyMinutes: patch.dailyMinutes !== undefined
          ? Math.max(0, Math.min(600, Math.round(Number(patch.dailyMinutes) || 0)))
          : cur.dailyMinutes,
        updatedAt: Date.now()
      };
      data.goals = next;
      save();
      scheduleSync(400);
      return next;
    },

    /** 今日目标进度 */
    goalProgress() { return M.goalProgress(data, Date.now()); },

    /** 近 N 天目标达成情况 */
    goalHistory(days) { return M.goalHistory(data, days || 14, Date.now()); },

    /* ---------- 统计 ---------- */
    /**
     * 汇总统计。结果会被缓存，直到数据发生变化。
     * 单次遍历算出全部计数，避免多次 reduce。
     */
    stats() {
      if (statsCache) return statsCache;

      let answered = 0, correct = 0, wrongTotal = 0, touched = 0;
      for (const id in data.records) {
        const r = data.records[id];
        if (!r) continue;
        touched++;
        answered += r.attempts || 0;
        correct += r.correct || 0;
        wrongTotal += r.wrong || 0;
      }

      statsCache = {
        answered, correct, wrongTotal,
        accuracy: answered ? Math.round((correct / answered) * 100) : 0,
        touched,
        wrongBook: this.wrongCount(),
        favorites: this.favoriteCount(),
        streakDays: data.streak.days || 0,
        exams: data.exams.length,
        dueToday: this.dueCount(),
        notes: this.noteCount(),
        daily: data.daily
      };
      return statsCache;
    },

    resetAll() {
      data = defaultData();
      pending = [];
      saveQueue();
      save();
      if (currentUser && window.Api) {
        // 显式覆盖，用于「清空进度」
        window.Api.clearProgress().catch(() => {});
      }
    },

    exportJSON() { return JSON.stringify(data, null, 2); },
    importJSON(text) {
      const parsed = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null) throw new Error("格式不正确");
      data = { ...defaultData(), ...parsed };
      save();
      scheduleSync();
    }
  };
})();

window.Store = Store;
