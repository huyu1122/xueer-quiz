/**
 * 学而刷题 —— 应用主逻辑
 * 无框架、无构建工具，直接操作 DOM。
 *
 * 结构：render() 只负责「渲染 HTML + 绑定事件」两步，
 * 每个视图有独立的 bindXxx() 负责事件绑定。
 */
(() => {
  "use strict";

  const S = window.Store;
  const app = document.getElementById("app");
  const toastEl = document.getElementById("toast");

  /* 题库：默认用内置题库，服务端可用时替换为服务端题库 */
  let BANK = window.QUESTION_BANK || [];
  let bankSource = "builtin";     // builtin | server
  let serverMeta = null;          // 服务端题库元信息

  /* ============================================================
     一、工具函数
     ============================================================ */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const esc = (s) => String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  /**
   * 渲染可能含 LaTeX 公式的内容（题干、选项、解析）。
   * 内部已做 HTML 转义与 KaTeX trust 关闭，安全可用。
   * KaTeX 未加载时降级为转义原文。
   */
  const rich = (s) => (window.Render ? window.Render.rich(s) : esc(s));

  const LETTERS = ["A", "B", "C", "D", "E", "F"];
  const TYPE_LABEL = { single: "单选题", multiple: "多选题", judge: "判断题", fill: "填空题" };
  const DIFF_LABEL = { 1: "基础", 2: "中等", 3: "较难" };

  function toast(msg, ms = 2000) {
    toastEl.textContent = msg;
    toastEl.classList.add("is-show");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove("is-show"), ms);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
  }

  function fmtDate(ts) {
    const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function filterBank({ subject, chapter, difficulty, type, knowledge } = {}) {
    return BANK.filter(q =>
      (!subject || subject === "all" || q.subject === subject) &&
      (!chapter || chapter === "all" || q.chapter === chapter) &&
      (!difficulty || difficulty === "all" || String(q.difficulty) === String(difficulty)) &&
      (!type || type === "all" || q.type === type) &&
      (!knowledge || knowledge === "all" || (q.knowledge || []).includes(knowledge))
    );
  }

  const byId = (id) => BANK.find(q => q.id === id);

  /** 归一化填空答案：全角转半角、去空白、去中英标点、统一小写 */
  function normFill(s) {
    return String(s ?? "")
      .trim().toLowerCase()
      .replace(/[\uff01-\uff5e]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/\s+/g, "")
      .replace(/[，。；：、（）【】“”‘’？！,.;:()\[\]"'?!]/g, "");
  }

  function isCorrect(q, ans) {
    if (q.type === "fill") {
      const user = normFill(ans);
      if (!user) return false;
      return (q.answer || []).some(a => normFill(a) === user);
    }
    const a = (ans || []).slice().sort().join(",");
    const b = (q.answer || []).slice().sort().join(",");
    return a !== "" && a === b;
  }

  function answerText(q) {
    if (q.type === "fill") return (q.answer || []).join(" / ");
    return (q.answer || [])
      .map(i => q.type === "judge" ? q.options[i] : `${LETTERS[i]}. ${q.options[i]}`)
      .join("；");
  }

  /** 该题是否需要点「提交」才判分 */
  function needsSubmit(q, mode) {
    if (mode === "exam") return false;
    if (q.type === "multiple") return true;
    return !S.settings().instantJudge;
  }

  /** 生成复习状态小标签 */
  function reviewChip(qid) {
    const r = S.getReview(qid);
    if (!r) return "";
    const DAY = 86400000;
    if ((r.stage || 0) >= 4) return '<span class="review-chip is-mastered">已掌握</span>';
    const left = r.dueAt - Date.now();
    if (left <= 0) return '<span class="review-chip is-due">待复习</span>';
    const days = Math.ceil(left / DAY);
    return `<span class="review-chip">${days} 天后复习</span>`;
  }

  const hasAnswer = (a) => a !== null && a !== undefined && (!Array.isArray(a) || a.length > 0);

  /* ============================================================
     二、全局状态
     ============================================================ */
  const state = { view: "home", practice: null, exam: null, lastExamResult: null };
  let examTimerId = null;

  function createSession(questions, opts = {}) {
    return {
      questions,
      index: 0,
      answers: questions.map(() => null),
      judged: questions.map(() => false),
      flags: questions.map(() => false),
      startedAt: Date.now(),
      mode: opts.mode || "practice",
      durationSec: opts.durationSec || 0,
      title: opts.title || "练习",
      finished: false,
      endAt: opts.durationSec ? Date.now() + opts.durationSec * 1000 : 0
    };
  }

  const currentSession = () =>
    state.view === "practice" ? state.practice :
    state.view === "exam" ? state.exam : null;

  /* ============================================================
     三、渲染调度
     ============================================================ */
  function viewHtml() {
    switch (state.view) {
      case "login": return htmlLogin();
      case "review": return htmlReview();
      case "knowledge": return htmlKnowledge();
      case "notes": return htmlNotes();
      case "practice": return state.practice ? htmlQuiz("practice") : htmlPracticeSetup();
      case "exam":
        if (state.lastExamResult) return htmlExamResult();
        return state.exam ? htmlQuiz("exam") : htmlExamSetup();
      case "wrong": return htmlWrong();
      case "favorite": return htmlFavorite();
      case "stats": return htmlStats();
      case "settings": return htmlSettings();
      default: return htmlHome();
    }
  }

  function afterRender() {
    switch (state.view) {
      case "login": bindLogin(); break;
      case "review": bindReview(); break;
      case "knowledge": bindKnowledge(); break;
      case "notes": bindNotes(); break;
      case "home": bindHome(); break;
      case "practice":
        state.practice ? bindQuiz("practice") : bindPracticeSetup();
        break;
      case "exam":
        if (state.lastExamResult) bindExamResult();
        else if (state.exam) { bindQuiz("exam"); startExamTimer(); }
        else bindExamSetup();
        break;
      case "wrong": bindWrong(); break;
      case "favorite": bindFavorite(); break;
      case "stats": bindStats(); break;
      case "settings": bindSettings(); break;
    }
    bindCommon();
    bindAuthUI();
    bindErrorPanel();
    updateNav();
    updateAuthUI();
    updateFooter();
  }

  function render() {
    try {
      app.innerHTML = viewHtml();
    } catch (e) {
      // 渲染失败时给出可读提示，而不是留一个空白页
      console.error("视图渲染失败：", e);
      app.innerHTML = errorPanel("页面渲染出错", e);
      return;
    }

    try {
      afterRender();
    } catch (e) {
      /*
       * 事件绑定失败不应让页面变成空白。
       * 内容已经渲染出来了（可读、可滚动），只是部分交互失效。
       * 这里记录错误并提示，让用户至少能看到题目。
       */
      console.error("事件绑定失败：", e);
      showBindError(e);
    }
  }

  /** 渲染一个错误面板（用于致命错误） */
  function errorPanel(title, e) {
    const msg = (e && e.message) ? e.message : String(e);
    return `
      <div class="card" style="border-color:var(--danger)">
        <div class="card-title" style="color:var(--danger)">⚠ ${esc(title)}</div>
        <p class="text-sm text-2 mb-12">${esc(msg)}</p>
        <p class="text-xs text-3 mb-16">
          本地数据可能已损坏。可尝试「重置本地数据」——题库与服务器上的进度不受影响。
        </p>
        <div class="row">
          <button class="btn btn-primary" id="errReload">重新加载页面</button>
          <button class="btn btn-danger" id="errReset">重置本地数据</button>
        </div>
      </div>`;
  }

  /** 事件绑定失败时，在页面顶部显示一条提示（不破坏已渲染内容） */
  function showBindError(e) {
    if ($("#bindErrorBar")) return;   // 避免重复插入
    const bar = document.createElement("div");
    bar.id = "bindErrorBar";
    bar.className = "due-banner";
    bar.style.borderColor = "var(--danger)";
    bar.style.background = "var(--danger-weak)";
    bar.innerHTML = `
      <div class="due-banner-main">
        <span class="due-banner-icon">⚠</span>
        <div class="due-banner-text">
          <strong>部分交互未能初始化</strong>
          <span>${esc((e && e.message) || String(e))}</span>
        </div>
      </div>
      <button class="btn btn-sm" id="bindErrReset">重置本地数据</button>`;
    app.insertBefore(bar, app.firstChild);

    const btn = $("#bindErrReset");
    if (btn) btn.onclick = () => {
      if (confirm("重置本地数据？题库与服务端进度不受影响，本地学习记录会清空。")) {
        try { localStorage.removeItem("xueer-quiz-v1"); } catch {}
        location.reload();
      }
    };
  }

  /** 绑定错误面板上的按钮 */
  function bindErrorPanel() {
    const reload = $("#errReload");
    if (reload) reload.onclick = () => location.reload();
    const reset = $("#errReset");
    if (reset) reset.onclick = () => {
      if (confirm("重置本地数据？题库与服务端进度不受影响。")) {
        try { localStorage.removeItem("xueer-quiz-v1"); } catch {}
        location.reload();
      }
    };
  }

  function go(view) {
    if (view !== "exam") { clearInterval(examTimerId); examTimerId = null; }
    if (view !== "practice") state.practice = null;
    state.view = view;
    window.scrollTo({ top: 0, behavior: "smooth" });
    render();
  }

  function bindCommon() {
    $$("[data-nav]").forEach(el => {
      el.onclick = () => {
        const v = el.dataset.nav;
        if (v === "exam") {
          if (state.exam && !state.exam.finished) {
            if (!confirm("当前有未交卷的模拟考试，确定离开吗？本次作答将丢失。")) return;
            state.exam = null;
          } else if (state.lastExamResult) {
            // 已有成绩单时再点「模拟考」，回到考试设置页
            state.lastExamResult = null;
          }
        } else {
          state.lastExamResult = null;
        }
        go(v);
      };
    });
  }

  function updateNav() {
    $$("#mainNav .nav-item").forEach(b =>
      b.classList.toggle("is-active", b.dataset.nav === state.view));

    /* 角标是装饰性的：任何一项取数失败都不应影响页面主体 */
    let wc = 0, fc = 0, dc = 0, nc = 0;
    try { wc = S.wrongCount(); } catch { /* 忽略 */ }
    try { fc = S.favoriteCount(); } catch { /* 忽略 */ }
    try { dc = S.dueCount(); } catch { /* 忽略 */ }
    try { nc = S.noteCount(); } catch { /* 忽略 */ }

    const wb = $("#navWrongBadge"), fb = $("#navFavBadge"), db = $("#navDueBadge"), nb = $("#navNoteBadge");
    if (wb) { wb.textContent = wc; wb.dataset.zero = wc ? "0" : "1"; }
    if (fb) { fb.textContent = fc; fb.dataset.zero = fc ? "0" : "1"; }
    if (db) { db.textContent = dc; db.dataset.zero = dc ? "0" : "1"; }
    if (nb) { nb.textContent = nc; nb.dataset.zero = nc ? "0" : "1"; }
  }

  function updateFooter() {
    const el = $("#footerStat");
    if (!el) return;
    try {
      const st = S.stats();
      el.textContent = `已练 ${st.answered} 题 · 正确率 ${st.accuracy}% · 连续打卡 ${st.streakDays} 天`;
    } catch (e) {
      el.textContent = "";
      console.warn("页脚统计失败：", e);
    }
  }

  /* ============================================================
     四、首页
     ============================================================ */
  function htmlHome() {
    const st = S.stats();
    const records = S.data.records;
    const subjects = [...new Set(BANK.map(q => q.subject))];

    const cards = subjects.map(sub => {
      const qs = BANK.filter(q => q.subject === sub);
      const done = qs.filter(q => records[q.id]).length;
      const pct = Math.round((done / qs.length) * 100);
      const chapters = new Set(qs.map(q => q.chapter)).size;
      return `
        <button class="subject-card" data-start-subject="${esc(sub)}">
          <h4>${esc(sub)}</h4>
          <div class="subject-meta">${qs.length} 题 · ${chapters} 章节 · 已练 ${done}</div>
          <div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>
        </button>`;
    }).join("");

    const exams = S.examList().slice(0, 5);
    const examRows = exams.length ? exams.map(e => `
      <div class="list-item">
        <div class="list-item-main">
          <div class="list-item-title">${esc(e.subject)} · ${e.right}/${e.total} 题</div>
          <div class="list-item-meta"><span>${fmtDate(e.at)}</span><span>用时 ${fmtTime(e.durationSec)}</span></div>
        </div>
        <div class="fw-600 ${e.score >= 60 ? "text-success" : "text-danger"}">${e.score} 分</div>
      </div>`).join("")
      : `<div class="empty"><div class="empty-icon">📝</div><h3>还没有考试记录</h3><p class="text-sm">去「模拟考」做一次限时测试吧</p></div>`;

    return `
      <section class="hero">
        <h1>欢迎回来，今天也要坚持刷题 💪</h1>
        <p>覆盖高等数学、线性代数、概率论、大学英语、计算机基础、数据结构、大学物理、思政、经管与法学等课程，支持分类练习、间隔重复复习、限时模拟考、错题本与知识点掌握度分析。</p>
        <div class="hero-actions">
          <button class="btn btn-primary btn-lg" data-nav="practice">开始练习</button>
          ${st.dueToday ? `<button class="btn btn-ghost btn-lg" data-nav="review">今日复习（${st.dueToday}）</button>` : ""}
          <button class="btn btn-ghost btn-lg" data-nav="exam">模拟考试</button>
          <button class="btn btn-ghost btn-lg" data-nav="wrong">错题本（${st.wrongBook}）</button>
        </div>
      </section>

      ${st.dueToday ? `
        <div class="due-banner">
          <div class="due-banner-main">
            <span class="due-banner-icon">🔔</span>
            <div class="due-banner-text">
              <strong>有 ${st.dueToday} 道题到了复习时间</strong>
              <span>按遗忘曲线安排，现在复习效果最好</span>
            </div>
          </div>
          <button class="btn btn-primary" data-nav="review">去复习</button>
        </div>` : ""}

      ${goalCard(S.goalProgress())}

      <div class="grid grid-4 mb-16">
        <div class="stat-card"><div class="stat-value is-primary">${st.answered}</div><div class="stat-label">累计答题</div></div>
        <div class="stat-card"><div class="stat-value is-success">${st.accuracy}%</div><div class="stat-label">总正确率</div></div>
        <div class="stat-card"><div class="stat-value is-danger">${st.wrongBook}</div><div class="stat-label">错题本</div></div>
        <div class="stat-card"><div class="stat-value is-warn">${st.streakDays}</div><div class="stat-label">连续打卡（天）</div></div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>按学科练习</span>
          <span class="text-xs text-3">共 ${BANK.length} 题 · ${subjects.length} 个学科</span>
        </div>
        <div class="grid grid-3">${cards}</div>
      </div>

      ${goalCalendar()}

      <div class="card">
        <div class="card-title">
          <span>最近考试</span>
          ${exams.length ? '<button class="btn btn-sm" data-nav="stats">查看全部</button>' : ""}
        </div>
        ${examRows}
      </div>`;
  }

  function bindHome() {
    $$("[data-start-subject]").forEach(btn => {
      btn.onclick = () => {
        const subject = btn.dataset.startSubject;
        state.practice = createSession(filterBank({ subject }), { title: `${subject} · 全部题目` });
        state.view = "practice";
        render();
      };
    });

    const quick = $("#goalQuick20");
    if (quick) quick.onclick = () => {
      S.setGoals({ dailyQuestions: 20 });
      toast("已设定每日目标：20 题");
      render();
    };
  }

  /* ============================================================
     五、练习模式
     ============================================================ */
  function htmlPracticeSetup() {
    const subjects = [...new Set(BANK.map(q => q.subject))];
    return `
      <h1 class="page-title">练习模式</h1>
      <p class="page-desc">自定义范围，逐题作答并即时查看解析。答错的题会自动收进错题本。</p>

      <div class="card">
        <div class="card-title">练习设置</div>
        <div class="grid grid-3">
          <div class="field">
            <label for="pSubject">学科</label>
            <select class="select" id="pSubject">
              <option value="all">全部学科</option>
              ${subjects.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="pChapter">章节</label>
            <select class="select" id="pChapter"><option value="all">全部章节</option></select>
          </div>
          <div class="field">
            <label for="pType">题型</label>
            <select class="select" id="pType">
              <option value="all">全部题型</option>
              <option value="single">单选题</option>
              <option value="multiple">多选题</option>
              <option value="judge">判断题</option>
              <option value="fill">填空题</option>
            </select>
          </div>
          <div class="field">
            <label for="pDiff">难度</label>
            <select class="select" id="pDiff">
              <option value="all">全部难度</option>
              <option value="1">基础</option>
              <option value="2">中等</option>
              <option value="3">较难</option>
            </select>
          </div>
          <div class="field">
            <label for="pKnowledge">知识点</label>
            <select class="select" id="pKnowledge">
              <option value="all">全部知识点</option>
            </select>
          </div>
          <div class="field">
            <label for="pCount">题目数量</label>
            <select class="select" id="pCount">
              <option value="10">10 题</option>
              <option value="20" selected>20 题</option>
              <option value="30">30 题</option>
              <option value="50">50 题</option>
              <option value="0">全部符合条件</option>
            </select>
          </div>
          <div class="field">
            <label for="pOrder">出题顺序</label>
            <select class="select" id="pOrder">
              <option value="random">随机打乱</option>
              <option value="origin">按题库顺序</option>
              <option value="wrongfirst">错题优先</option>
              <option value="unseen">未做过的优先</option>
            </select>
          </div>
        </div>
        <div class="row-between mt-16">
          <span class="text-sm text-2" id="pPreview">请选择条件</span>
          <button class="btn btn-primary btn-lg" id="pStart">开始练习</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">快捷入口</div>
        <div class="row">
          <button class="btn" data-quick="wrong">只练错题（${S.wrongCount()}）</button>
          <button class="btn" data-quick="fav">只练收藏（${S.favoriteCount()}）</button>
          <button class="btn" data-quick="unseen">练未做过的题</button>
          <button class="btn" data-quick="all-random">随机 20 题</button>
        </div>
      </div>`;
  }

  function bindPracticeSetup() {
    const selSubject = $("#pSubject"), selChapter = $("#pChapter"), selKnowledge = $("#pKnowledge");

    const curFilter = () => ({
      subject: selSubject.value,
      chapter: selChapter.value,
      type: $("#pType").value,
      difficulty: $("#pDiff").value,
      knowledge: selKnowledge ? selKnowledge.value : "all"
    });

    function refreshChapters() {
      const chapters = [...new Set(filterBank({ subject: selSubject.value }).map(q => q.chapter))];
      selChapter.innerHTML = `<option value="all">全部章节</option>` +
        chapters.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
    }

    /** 知识点下拉：随学科/章节联动，只列出范围内出现过的知识点 */
    function refreshKnowledge() {
      if (!selKnowledge) return;
      const scope = filterBank({ subject: selSubject.value, chapter: selChapter.value });
      const tags = [...new Set(scope.flatMap(q => q.knowledge || []))].sort();
      const keep = selKnowledge.value;
      selKnowledge.innerHTML = `<option value="all">全部知识点</option>` +
        tags.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("");
      if (tags.includes(keep)) selKnowledge.value = keep;
    }

    function refreshPreview() {
      $("#pPreview").textContent = `符合条件的题目：${filterBank(curFilter()).length} 道`;
    }

    selSubject.onchange = () => { refreshChapters(); refreshKnowledge(); refreshPreview(); };
    selChapter.onchange = () => { refreshKnowledge(); refreshPreview(); };
    ["#pType", "#pDiff"].forEach(s => { $(s).onchange = refreshPreview; });
    if (selKnowledge) selKnowledge.onchange = refreshPreview;

    refreshChapters();
    refreshKnowledge();
    refreshPreview();

    $("#pStart").onclick = () => {
      const f = curFilter();
      let list = filterBank(f);
      if (!list.length) { toast("没有符合条件的题目，请调整筛选"); return; }

      const order = $("#pOrder").value;
      const records = S.data.records;

      if (order === "wrongfirst") list.sort((a, b) => (S.data.wrong[b.id] ? 1 : 0) - (S.data.wrong[a.id] ? 1 : 0));
      else if (order === "unseen") list.sort((a, b) => (records[a.id] ? 1 : 0) - (records[b.id] ? 1 : 0));
      else if (order === "random") list = shuffle(list);

      const count = Number($("#pCount").value);
      if (count > 0) list = list.slice(0, count);
      if (!list.length) { toast("没有可用的题目"); return; }

      const parts = [];
      if (f.subject !== "all") parts.push(f.subject);
      if (f.chapter !== "all") parts.push(f.chapter);
      if (f.knowledge && f.knowledge !== "all") parts.push(f.knowledge);
      if (f.type !== "all") parts.push(TYPE_LABEL[f.type]);
      if (f.difficulty !== "all") parts.push(DIFF_LABEL[f.difficulty]);

      state.practice = createSession(list, { title: parts.length ? parts.join(" · ") : "综合练习" });
      render();
    };

    $$("[data-quick]").forEach(btn => {
      btn.onclick = () => {
        const kind = btn.dataset.quick;
        let list = [];
        if (kind === "wrong") list = S.wrongList().map(byId).filter(Boolean);
        else if (kind === "fav") list = S.favoriteList().map(byId).filter(Boolean);
        else if (kind === "unseen") list = shuffle(BANK.filter(q => !S.data.records[q.id]));
        else list = shuffle(BANK).slice(0, 20);

        if (!list.length) { toast("没有可用的题目"); return; }
        state.practice = createSession(list, { title: btn.textContent.trim() });
        render();
      };
    });
  }

  /* ============================================================
     六、答题界面（练习 / 考试共用）
     ============================================================ */
  function htmlQuiz(mode) {
    const sess = currentSession();
    const q = sess.questions[sess.index];
    const ans = sess.answers[sess.index];
    const judged = mode === "practice" && sess.judged[sess.index];
    const total = sess.questions.length;
    const answered = sess.answers.filter(hasAnswer).length;
    const rec = S.getRecord(q.id);

    /* 选项 / 填空 */
    const needSubmit = needsSubmit(q, mode);
    let bodyHtml;
    if (q.type === "fill") {
      bodyHtml = `
        <div class="fill-row">
          <input class="input" id="fillInput" placeholder="输入答案后按 Enter 或点右侧按钮"
                 value="${esc(typeof ans === "string" ? ans : "")}"
                 ${judged ? "disabled" : ""} autocomplete="off">
          ${judged ? "" : '<button class="btn btn-primary" id="btnJudgeSubmit">提交本题</button>'}
        </div>`;
    } else {
      const selected = Array.isArray(ans) ? ans : [];
      bodyHtml = `<div class="options">` + q.options.map((opt, i) => {
        const cls = ["option"];
        if (selected.includes(i)) cls.push("is-selected");
        if (judged) {
          cls.push("is-locked");
          if ((q.answer || []).includes(i)) cls.push("is-correct");
          else if (selected.includes(i)) cls.push("is-wrong");
        }
        return `
          <button class="${cls.join(" ")}" data-opt="${i}" ${judged ? "disabled" : ""}>
            <span class="option-key">${q.type === "judge" ? (i === 0 ? "√" : "×") : LETTERS[i]}</span>
            <span class="option-text">${rich(opt)}</span>
          </button>`;
      }).join("") + `</div>`;

      if (!judged && needSubmit) {
        bodyHtml += `<p class="text-xs text-3 mt-8">${q.type === "multiple"
          ? "多选题：可选中多个选项，选好后点「提交本题」判分。"
          : "选好答案后点「提交本题」判分。"}</p>
          <button class="btn btn-primary mt-12" id="btnJudgeSubmit">提交本题</button>`;
      }
    }

    /* 解析 */
    let analysisHtml = "";
    if (judged) {
      const right = isCorrect(q, ans);
      analysisHtml = `
        <div class="analysis ${right ? "is-right" : "is-wrong"}">
          <div class="analysis-title">${right ? "✅ 回答正确" : "❌ 回答错误"}</div>
          <div>${rich(q.analysis || "暂无解析")}</div>
          <div class="answer-line"><strong>正确答案：</strong>${rich(answerText(q))}</div>
        </div>`;
    }

    /* 我的笔记：答题后展示，方便对照解析复盘 */
    const note = S.getNote(q.id);
    const noteHtml = note ? `
      <div class="my-note">
        <div class="my-note-head">
          <span>📝 我的笔记</span>
          <button class="btn btn-sm" id="btnNoteEdit">编辑</button>
        </div>
        <div class="my-note-body">${rich(note.text)}</div>
      </div>` : "";

    return `
      <div class="quiz-head">
        <div class="quiz-tags">
          <span class="tag tag-primary">${esc(q.subject)}</span>
          <span class="tag">${esc(q.chapter)}</span>
          <span class="tag">${TYPE_LABEL[q.type]}</span>
          <span class="tag ${q.difficulty === 3 ? "tag-danger" : q.difficulty === 2 ? "tag-warn" : "tag-success"}">${DIFF_LABEL[q.difficulty]}</span>
          ${(q.knowledge || []).map(k => `<span class="tag tag-knowledge">${esc(k)}</span>`).join("")}
          ${reviewChip(q.id)}
          ${rec && rec.lastResult === "wrong" ? '<span class="tag tag-danger">曾做错</span>' : ""}
          ${sess.flags[sess.index] ? '<span class="tag tag-warn">已标记</span>' : ""}
        </div>
        <div class="row">
          ${mode === "exam" ? '<span class="timer" id="examTimer">--:--</span>' : ""}
          <button class="btn btn-sm" id="btnNote" title="为这道题写笔记">
            ${S.getNote(q.id) ? "📝 已记笔记" : "📝 笔记"}
          </button>
          <button class="btn btn-sm" id="btnFav">${S.isFavorite(q.id) ? "★ 已收藏" : "☆ 收藏"}</button>
          <button class="btn btn-sm" id="btnFlag">${sess.flags[sess.index] ? "取消标记" : "标记待定"}</button>
        </div>
      </div>

      <div class="quiz-progress">
        <span class="num">第 ${sess.index + 1} / ${total} 题</span>
        <span class="bar"><i style="width:${(answered / total) * 100}%"></i></span>
        <span class="num">已答 ${answered}</span>
      </div>

      <div class="card">
        <div class="q-stem">${rich(q.stem)}</div>
        ${bodyHtml}
        ${analysisHtml}
        ${noteHtml}
        <div class="row-between mt-20">
          <div class="row">
            <button class="btn" id="btnPrev" ${sess.index === 0 ? "disabled" : ""}>上一题</button>
            ${mode === "practice"
              ? '<button class="btn" id="btnSkip">跳过</button>'
              : '<button class="btn" id="btnPrevUnanswered">上一道未答</button>'}
          </div>
          <div class="row">
            <button class="btn btn-primary" id="btnNext">
              ${mode === "practice"
                ? (sess.index === total - 1 ? "完成练习" : "下一题")
                : (sess.index === total - 1 ? "最后一题" : "下一题")}
            </button>
            ${mode === "exam" ? '<button class="btn btn-success" id="btnSubmit">交卷</button>' : ""}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">
          <span>答题卡</span>
          <span class="text-xs text-3">点击题号可跳转</span>
        </div>
        <div class="sheet">
          ${sess.questions.map((_, i) => sheetCell(sess, i, mode)).join("")}
        </div>
        <div class="sheet-legend">
          <span><i style="background:var(--primary-weak);border:1px solid var(--primary)"></i>已答</span>
          ${mode === "practice" ? `
            <span><i style="background:var(--success-weak);border:1px solid var(--success)"></i>答对</span>
            <span><i style="background:var(--danger-weak);border:1px solid var(--danger)"></i>答错</span>` : ""}
          <span><i style="background:var(--bg-card);border:1px solid var(--border)"></i>未答</span>
          <span><i style="background:var(--warn-weak);border:1px solid var(--warn)"></i>已标记</span>
        </div>
        ${mode === "practice" ? `
          <div class="row-between mt-16">
            <span class="text-sm text-2">本次练习：答对 ${countCorrect(sess)} / 已答 ${answered}</span>
            <button class="btn btn-sm" id="btnFinish">结束并查看成绩</button>
          </div>` : ""}
      </div>`;
  }

  function sheetCell(sess, i, mode) {
    const cls = ["sheet-cell"];
    const a = sess.answers[i];
    const style = [];

    if (i === sess.index) cls.push("is-current");

    if (mode === "practice" && sess.judged[i]) {
      cls.push(isCorrect(sess.questions[i], a) ? "is-right" : "is-wrong");
    } else if (hasAnswer(a)) {
      cls.push("is-done");
    } else if (sess.flags[i]) {
      style.push("background:var(--warn-weak)", "border-color:var(--warn)", "color:var(--warn)");
    }

    return `<button class="${cls.join(" ")}" data-jump="${i}" style="${style.join(";")}">${i + 1}</button>`;
  }

  function countCorrect(sess) {
    return sess.questions.reduce((n, q, i) =>
      n + (sess.judged[i] && isCorrect(q, sess.answers[i]) ? 1 : 0), 0);
  }

  function bindQuiz(mode) {
    const sess = currentSession();
    if (!sess) return;
    const q = sess.questions[sess.index];
    const judgedNow = () => mode === "practice" && sess.judged[sess.index];

    /** 判分（练习模式） */
    function judge() {
      const cur = sess.questions[sess.index];
      const right = isCorrect(cur, sess.answers[sess.index]);
      sess.judged[sess.index] = true;
      S.recordAnswer(cur.id, right);
      toast(right ? "回答正确 ✅" : "回答错误，看看解析 ❌");

      if (right && S.settings().autoNext && sess.index < sess.questions.length - 1) {
        setTimeout(() => { sess.index += 1; render(); }, 480);
      } else {
        render();
      }
    }

    /* ---- 选项点击 ---- */
    $$("[data-opt]").forEach(btn => {
      btn.onclick = () => {
        if (judgedNow()) return;
        const i = Number(btn.dataset.opt);

        if (q.type === "multiple") {
          const cur = Array.isArray(sess.answers[sess.index]) ? sess.answers[sess.index].slice() : [];
          const pos = cur.indexOf(i);
          if (pos >= 0) cur.splice(pos, 1); else cur.push(i);
          sess.answers[sess.index] = cur.sort((a, b) => a - b);
        } else {
          sess.answers[sess.index] = [i];
          if (!needsSubmit(q, mode)) { judge(); return; }
        }
        syncOptionUI(q, sess.answers[sess.index]);
        syncProgress(sess);
        syncSheet(sess, mode);
      };
    });

    /* ---- 提交本题（多选 / 关闭即时判分后的单选） ---- */
    const submitBtn = $("#btnJudgeSubmit");
    if (submitBtn) submitBtn.onclick = () => {
      if (q.type === "fill") {
        const v = $("#fillInput").value;
        if (!v.trim()) { toast("请先输入答案"); return; }
        sess.answers[sess.index] = v;
      } else if (!hasAnswer(sess.answers[sess.index])) {
        toast("请先选择答案"); return;
      }
      judge();
    };

    /* ---- 填空输入 ---- */
    const fillInput = $("#fillInput");
    if (fillInput) {
      fillInput.oninput = () => { sess.answers[sess.index] = fillInput.value; syncProgress(sess); syncSheet(sess, mode); };
      fillInput.onkeydown = (e) => {
        if (e.key === "Enter" && !judgedNow()) {
          e.preventDefault();
          const b = $("#btnJudgeSubmit");
          if (b) b.click();
        }
      };
      if (!judgedNow()) setTimeout(() => fillInput.focus(), 60);
    }

    /* ---- 上下题 ---- */
    const prev = $("#btnPrev");
    if (prev) prev.onclick = () => { if (sess.index > 0) { sess.index -= 1; render(); } };

    $("#btnNext").onclick = () => {
      if (mode === "practice" && sess.index === sess.questions.length - 1) { finishPractice(sess); return; }
      if (sess.index < sess.questions.length - 1) { sess.index += 1; render(); }
      else toast("已经是最后一题了");
    };

    const skip = $("#btnSkip");
    if (skip) skip.onclick = () => {
      if (sess.index < sess.questions.length - 1) { sess.index += 1; render(); }
      else toast("已经是最后一题了");
    };

    const prevUn = $("#btnPrevUnanswered");
    if (prevUn) prevUn.onclick = () => {
      for (let i = sess.index - 1; i >= 0; i--) {
        if (!hasAnswer(sess.answers[i])) { sess.index = i; render(); return; }
      }
      toast("前面没有未作答的题目");
    };

    /* ---- 交卷 / 结束 ---- */
    const submit = $("#btnSubmit");
    if (submit) submit.onclick = () => confirmSubmitExam(sess);

    const finish = $("#btnFinish");
    if (finish) finish.onclick = () => finishPractice(sess);

    /* ---- 收藏 / 笔记 / 标记 ---- */
    const noteBtn = $("#btnNote");
    if (noteBtn) noteBtn.onclick = () => openNoteEditor(q);

    const noteEdit = $("#btnNoteEdit");
    if (noteEdit) noteEdit.onclick = () => openNoteEditor(q);

    $("#btnFav").onclick = () => {
      toast(S.toggleFavorite(q.id) ? "已加入收藏 ⭐" : "已取消收藏");
      render();
    };
    $("#btnFlag").onclick = () => {
      sess.flags[sess.index] = !sess.flags[sess.index];
      render();
    };

    /* ---- 答题卡跳转 ---- */
    $$("[data-jump]").forEach(b => {
      b.onclick = () => { sess.index = Number(b.dataset.jump); render(); };
    });
  }

  function syncOptionUI(q, selected) {
    $$("[data-opt]").forEach(btn => {
      const i = Number(btn.dataset.opt);
      btn.classList.toggle("is-selected", (selected || []).includes(i));
    });
  }

  function syncProgress(sess) {
    const total = sess.questions.length;
    const answered = sess.answers.filter(hasAnswer).length;
    const bar = $(".quiz-progress .bar > i");
    if (bar) bar.style.width = `${(answered / total) * 100}%`;
    const nums = $$(".quiz-progress .num");
    if (nums[1]) nums[1].textContent = `已答 ${answered}`;
  }

  function syncSheet(sess, mode) {
    const cells = $$(".sheet [data-jump]");
    cells.forEach((cell, i) => {
      const a = sess.answers[i];
      cell.classList.remove("is-right", "is-wrong", "is-done");
      cell.removeAttribute("style");
      if (mode === "practice" && sess.judged[i]) {
        cell.classList.add(isCorrect(sess.questions[i], a) ? "is-right" : "is-wrong");
      } else if (hasAnswer(a)) {
        cell.classList.add("is-done");
      } else if (sess.flags[i]) {
        cell.style.cssText = "background:var(--warn-weak);border-color:var(--warn);color:var(--warn)";
      }
    });
  }

  /* ============================================================
     七、练习结算
     ============================================================ */
  function finishPractice(sess) {
    if (!sess.questions.some((_, i) => hasAnswer(sess.answers[i]))) {
      toast("还没有作答任何题目"); return;
    }

    /* 未判分的题补判并记录 */
    sess.questions.forEach((q, i) => {
      if (!sess.judged[i] && hasAnswer(sess.answers[i])) {
        sess.judged[i] = true;
        S.recordAnswer(q.id, isCorrect(q, sess.answers[i]));
      }
    });

    const total = sess.questions.length;
    const right = sess.questions.filter((q, i) => sess.judged[i] && isCorrect(q, sess.answers[i])).length;
    const wrongQs = sess.questions.filter((q, i) => sess.judged[i] && !isCorrect(q, sess.answers[i]));
    const used = Math.round((Date.now() - sess.startedAt) / 1000);
    const pct = total ? Math.round((right / total) * 100) : 0;
    const color = pct >= 60 ? "var(--success)" : "var(--danger)";

    app.innerHTML = `
      <h1 class="page-title">练习完成 🎉</h1>
      <p class="page-desc">${esc(sess.title)} · 用时 ${fmtTime(used)}</p>

      <div class="card">
        <div class="exam-result-head">
          <div class="score-ring" style="background:conic-gradient(${color} ${pct * 3.6}deg, var(--bg-sub) 0deg)">
            <div>
              <div class="score-num" style="color:${color}">${right}</div>
              <div class="score-unit">/ ${total} 题</div>
            </div>
          </div>
          <div style="flex:1;min-width:220px">
            <div class="grid grid-3">
              <div class="stat-card"><div class="stat-value is-success">${right}</div><div class="stat-label">答对</div></div>
              <div class="stat-card"><div class="stat-value is-danger">${wrongQs.length}</div><div class="stat-label">答错</div></div>
              <div class="stat-card"><div class="stat-value is-primary">${pct}%</div><div class="stat-label">正确率</div></div>
            </div>
            <div class="row mt-16">
              <button class="btn btn-primary" data-nav="practice">再练一组</button>
              ${wrongQs.length ? `<button class="btn btn-danger" id="retryWrong">重做错题（${wrongQs.length}）</button>` : ""}
              <button class="btn" data-nav="wrong">查看错题本</button>
            </div>
          </div>
        </div>
      </div>

      ${wrongQs.length ? `
        <div class="card">
          <div class="card-title">错题回顾（${wrongQs.length} 题）</div>
          ${wrongQs.map(q => `
            <div class="list-item" style="align-items:flex-start">
              <div class="list-item-main">
                <div class="list-item-title" style="white-space:normal">${rich(q.stem)}</div>
                <div class="list-item-meta">
                  <span>${esc(q.subject)}</span>
                  <span>${esc(q.chapter)}</span>
                  <span class="text-success">正确答案：${rich(answerText(q))}</span>
                </div>
              </div>
            </div>`).join("")}
        </div>` : `
        <div class="card">
          <div class="empty">
            <div class="empty-icon">🌟</div>
            <h3>全部答对，太棒了！</h3>
            <p class="text-sm">可以挑战更高难度，或试试模拟考试</p>
          </div>
        </div>`}`;

    bindCommon(); updateNav(); updateFooter();
    const rw = $("#retryWrong");
    if (rw) rw.onclick = () => {
      state.practice = createSession(shuffle(wrongQs), { title: "错题重做" });
      render();
    };
    window.scrollTo({ top: 0 });
  }

  /* ============================================================
     八、模拟考试
     ============================================================ */
  function htmlExamSetup() {
    const subjects = [...new Set(BANK.map(q => q.subject))];
    return `
      <h1 class="page-title">模拟考试</h1>
      <p class="page-desc">限时作答，交卷后统一评分并给出成绩单。考试中不显示答案，可标记待定后回头检查。</p>

      <div class="card">
        <div class="card-title">考试设置</div>
        <div class="grid grid-3">
          <div class="field">
            <label for="eSubject">考试范围</label>
            <select class="select" id="eSubject">
              <option value="all">综合卷（全部学科）</option>
              ${subjects.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join("")}
            </select>
          </div>
          <div class="field">
            <label for="eCount">题目数量</label>
            <select class="select" id="eCount">
              <option value="10">10 题</option>
              <option value="20" selected>20 题</option>
              <option value="30">30 题</option>
              <option value="50">50 题</option>
            </select>
          </div>
          <div class="field">
            <label for="eTime">考试时长</label>
            <select class="select" id="eTime">
              <option value="10">10 分钟</option>
              <option value="20">20 分钟</option>
              <option value="30" selected>30 分钟</option>
              <option value="45">45 分钟</option>
              <option value="60">60 分钟</option>
              <option value="0">不限时</option>
            </select>
          </div>
        </div>
        <div class="row-between mt-16">
          <span class="text-sm text-2" id="ePreview"></span>
          <button class="btn btn-primary btn-lg" id="eStart">开始考试</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">考试须知</div>
        <ul class="text-sm text-2" style="padding-left:20px;margin:0;line-height:2">
          <li>题目随机抽取并打乱顺序，可提前交卷，也可等时间到自动交卷。</li>
          <li>考试过程中不显示对错，交卷后统一给出答案与解析。</li>
          <li>拿不准的题点「标记待定」，方便最后回头检查。</li>
          <li>刷新或离开页面会丢失本次进度，请一次完成。</li>
        </ul>
      </div>`;
  }

  function bindExamSetup() {
    const refresh = () => {
      $("#ePreview").textContent =
        `该范围共 ${filterBank({ subject: $("#eSubject").value }).length} 道题可供抽题`;
    };
    $("#eSubject").onchange = refresh;
    refresh();

    $("#eStart").onclick = () => {
      const subject = $("#eSubject").value;
      const count = Number($("#eCount").value);
      const minutes = Number($("#eTime").value);
      const pool = filterBank({ subject });
      if (!pool.length) { toast("该范围暂无题目"); return; }

      const picked = shuffle(pool).slice(0, Math.min(count, pool.length));
      state.exam = createSession(picked, {
        mode: "exam",
        durationSec: minutes * 60,
        title: `${subject === "all" ? "综合卷" : subject} · 模拟考`
      });
      state.lastExamResult = null;
      render();
    };
  }

  function startExamTimer() {
    clearInterval(examTimerId);
    const sess = state.exam;
    if (!sess) return;

    const el = $("#examTimer");
    if (!sess.durationSec) { if (el) el.textContent = "不限时"; return; }

    const tick = () => {
      const left = Math.max(0, Math.round((sess.endAt - Date.now()) / 1000));
      const t = $("#examTimer");
      if (t) {
        t.textContent = fmtTime(left);
        t.classList.toggle("is-warning", left <= 300 && left > 60);
        t.classList.toggle("is-danger", left <= 60);
      }
      if (left <= 0) {
        clearInterval(examTimerId); examTimerId = null;
        toast("考试时间到，自动交卷");
        submitExam(sess, true);
      }
    };
    tick();
    examTimerId = setInterval(tick, 1000);
  }

  function confirmSubmitExam(sess) {
    const un = sess.answers.filter(a => !hasAnswer(a)).length;
    if (confirm(un ? `还有 ${un} 道题未作答，确定交卷吗？` : "确定交卷吗？")) submitExam(sess, false);
  }

  function submitExam(sess, auto) {
    clearInterval(examTimerId); examTimerId = null;
    sess.finished = true;

    let right = 0;
    const detail = sess.questions.map((q, i) => {
      const ok = isCorrect(q, sess.answers[i]);
      if (ok) right += 1;
      S.recordAnswer(q.id, ok);
      return { qid: q.id, answer: sess.answers[i], correct: ok };
    });

    const total = sess.questions.length;
    const rec = {
      id: "e" + Date.now(),
      at: Date.now(),
      subject: sess.title,
      total, right,
      score: total ? Math.round((right / total) * 100) : 0,
      durationSec: Math.round((Date.now() - sess.startedAt) / 1000),
      auto: !!auto,
      detail
    };
    S.addExam(rec);

    state.lastExamResult = {
      session: sess,
      record: rec,
      wrongQs: sess.questions.filter((q, i) => !detail[i].correct)
    };
    state.exam = null;
    render();
    window.scrollTo({ top: 0 });
  }

  function htmlExamResult() {
    const { session: sess, record: rec, wrongQs } = state.lastExamResult;
    const grade = rec.score >= 90 ? "优秀" : rec.score >= 80 ? "良好" :
                  rec.score >= 70 ? "中等" : rec.score >= 60 ? "及格" : "不及格";
    const color = rec.score >= 90 ? "var(--success)" : rec.score >= 60 ? "var(--primary)" : "var(--danger)";
    const usedPct = sess.durationSec ? Math.round((rec.durationSec / sess.durationSec) * 100) : 0;

    return `
      <h1 class="page-title">考试成绩单</h1>
      <p class="page-desc">${esc(rec.subject)} · ${fmtDate(rec.at)}${rec.auto ? " · 时间到自动交卷" : ""}</p>

      <div class="card">
        <div class="exam-result-head">
          <div class="score-ring" style="background:conic-gradient(${color} ${rec.score * 3.6}deg, var(--bg-sub) 0deg)">
            <div>
              <div class="score-num" style="color:${color}">${rec.score}</div>
              <div class="score-unit">分 · ${grade}</div>
            </div>
          </div>
          <div style="flex:1;min-width:240px">
            <div class="grid grid-3">
              <div class="stat-card"><div class="stat-value is-success">${rec.right}</div><div class="stat-label">答对</div></div>
              <div class="stat-card"><div class="stat-value is-danger">${rec.total - rec.right}</div><div class="stat-label">答错</div></div>
              <div class="stat-card"><div class="stat-value is-primary">${rec.score}%</div><div class="stat-label">得分率</div></div>
            </div>
            <div class="text-sm text-2 mt-12">
              用时 ${fmtTime(rec.durationSec)}${sess.durationSec ? ` / 限时 ${fmtTime(sess.durationSec)}（占 ${usedPct}%）` : ""}
            </div>
            <div class="row mt-16">
              <button class="btn btn-primary" id="examAgain">再考一次</button>
              ${wrongQs.length ? `<button class="btn btn-danger" id="examRedoWrong">重做错题（${wrongQs.length}）</button>` : ""}
              <button class="btn" data-nav="stats">查看统计</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">逐题解析（${sess.questions.length} 题）</div>
        ${sess.questions.map((q, i) => {
          const d = rec.detail[i];
          const ua = d.answer;
          const userText = !hasAnswer(ua) ? "未作答"
            : q.type === "fill" ? ua
            : ua.map(x => q.type === "judge" ? q.options[x] : LETTERS[x]).join("、");
          return `
            <div class="list-item" style="align-items:flex-start">
              <div class="list-item-main">
                <div class="list-item-title" style="white-space:normal">
                  <span class="tag ${d.correct ? "tag-success" : "tag-danger"}">${d.correct ? "✓" : "✗"}</span>
                  ${i + 1}. ${rich(q.stem)}
                </div>
                <div class="list-item-meta" style="display:block">
                  <div>你的答案：<span class="${d.correct ? "text-success" : "text-danger"}">${esc(userText)}</span></div>
                  <div>正确答案：<span class="text-success">${rich(answerText(q))}</span></div>
                  <div class="text-3 mt-8">${rich(q.analysis || "")}</div>
                </div>
              </div>
            </div>`;
        }).join("")}
      </div>`;
  }

  function bindExamResult() {
    $("#examAgain").onclick = () => { state.lastExamResult = null; render(); };
    const redo = $("#examRedoWrong");
    if (redo) redo.onclick = () => {
      const qs = state.lastExamResult.wrongQs;
      state.lastExamResult = null;
      state.practice = createSession(shuffle(qs), { title: "考试错题重做" });
      state.view = "practice";
      render();
    };
  }

  /* ============================================================
     九、错题本
     ============================================================ */
  function htmlWrong() {
    const qs = S.wrongList().map(byId).filter(Boolean);
    if (!qs.length) {
      return `
        <h1 class="page-title">错题本</h1>
        <div class="card">
          <div class="empty">
            <div class="empty-icon">📕</div>
            <h3>错题本还是空的</h3>
            <p class="text-sm">练习或考试中答错的题会自动收进这里</p>
            <button class="btn btn-primary mt-16" data-nav="practice">去练习</button>
          </div>
        </div>`;
    }

    const groups = {};
    qs.forEach(q => { (groups[q.subject] = groups[q.subject] || []).push(q); });

    return `
      <h1 class="page-title">错题本</h1>
      <p class="page-desc">共 ${qs.length} 道错题。建议先看解析弄清错因，再整体重做一遍巩固。</p>

      <div class="card">
        <div class="row-between">
          <span class="text-sm text-2">已订正的题目会保留在列表中，方便考前复查</span>
          <div class="row">
            <button class="btn btn-primary" id="wPractice">开始重做（${qs.length}）</button>
            <button class="btn btn-danger" id="wClear">清空错题本</button>
          </div>
        </div>
      </div>

      ${Object.entries(groups).map(([sub, list]) => `
        <div class="card">
          <div class="card-title"><span>${esc(sub)} <span class="text-3 text-sm">（${list.length} 题）</span></span></div>
          ${list.map(q => {
            const w = S.data.wrong[q.id] || {};
            const rec = S.getRecord(q.id);
            return `
              <div class="list-item" style="align-items:flex-start">
                <div class="list-item-main">
                  <div class="list-item-title" style="white-space:normal">
                    ${w.cleared ? '<span class="tag tag-success">已订正</span>' : '<span class="tag tag-danger">未订正</span>'}
                    ${rich(q.stem)}
                  </div>
                  <div class="list-item-meta">
                    <span>${esc(q.chapter)}</span>
                    <span>${TYPE_LABEL[q.type]}</span>
                    <span>错 ${w.count || 1} 次</span>
                    ${rec ? `<span>累计作答 ${rec.attempts} 次</span>` : ""}
                    <span class="text-success">答案：${rich(answerText(q))}</span>
                  </div>
                </div>
                <div class="row" style="flex-shrink:0">
                  <button class="btn btn-sm" data-detail="${q.id}">看解析</button>
                  <button class="btn btn-sm" data-remove="${q.id}">移除</button>
                </div>
              </div>`;
          }).join("")}
        </div>`).join("")}`;
  }

  function bindWrong() {
    const qs = S.wrongList().map(byId).filter(Boolean);

    /*
     * 注意：错题本为空时 htmlWrong() 渲染的是空状态，
     * 不含 #wPractice / #wClear。这里必须做存在性判断，
     * 否则会抛 "Cannot set properties of null" 导致视图无法渲染。
     * （此问题由真实浏览器测试发现，DOM 桩测试未能覆盖。）
     */
    const wPractice = $("#wPractice");
    if (wPractice) wPractice.onclick = () => {
      state.practice = createSession(shuffle(qs), { title: "错题重做" });
      state.view = "practice";
      render();
    };

    const wClear = $("#wClear");
    if (wClear) wClear.onclick = () => {
      if (confirm("确定清空错题本吗？此操作不可恢复。")) { S.clearWrong(); toast("错题本已清空"); render(); }
    };
    $$("[data-remove]").forEach(b => {
      b.onclick = () => { S.removeWrong(b.dataset.remove); toast("已移除"); render(); };
    });
    $$("[data-detail]").forEach(b => {
      b.onclick = () => { const q = byId(b.dataset.detail); if (q) showQuestionModal(q); };
    });
  }

  function showQuestionModal(q) {
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `
      <div class="modal">
        <div class="quiz-tags mb-12">
          <span class="tag tag-primary">${esc(q.subject)}</span>
          <span class="tag">${esc(q.chapter)}</span>
          <span class="tag">${TYPE_LABEL[q.type]}</span>
          <span class="tag">${DIFF_LABEL[q.difficulty]}</span>
          ${(q.knowledge || []).map(k => `<span class="tag tag-knowledge">${esc(k)}</span>`).join("")}
        </div>
        <h3 style="font-size:16px;line-height:1.7">${rich(q.stem)}</h3>
        ${q.type === "fill" ? "" : `<div class="options mt-12">${q.options.map((o, i) => `
          <div class="option is-locked ${(q.answer || []).includes(i) ? "is-correct" : ""}">
            <span class="option-key">${q.type === "judge" ? (i === 0 ? "√" : "×") : LETTERS[i]}</span>
            <span class="option-text">${rich(o)}</span>
          </div>`).join("")}</div>`}
        <div class="analysis mt-16">
          <div class="analysis-title">📖 解析</div>
          <div>${rich(q.analysis || "暂无解析")}</div>
          <div class="answer-line"><strong>正确答案：</strong>${rich(answerText(q))}</div>
        </div>
        <div class="modal-actions"><button class="btn" data-close>关闭</button></div>
      </div>`;
    document.body.appendChild(mask);

    const close = () => { mask.remove(); document.removeEventListener("keydown", onEsc); };
    const onEsc = (e) => { if (e.key === "Escape") close(); };
    mask.onclick = (e) => { if (e.target === mask) close(); };
    $("[data-close]", mask).onclick = close;
    document.addEventListener("keydown", onEsc);
  }

  /* ============================================================
     十、收藏夹
     ============================================================ */
  function htmlFavorite() {
    const qs = S.favoriteList().map(byId).filter(Boolean);
    if (!qs.length) {
      return `
        <h1 class="page-title">我的收藏</h1>
        <div class="card">
          <div class="empty">
            <div class="empty-icon">⭐</div>
            <h3>还没有收藏题目</h3>
            <p class="text-sm">做题时点右上角「☆ 收藏」把重点题标记下来</p>
            <button class="btn btn-primary mt-16" data-nav="practice">去练习</button>
          </div>
        </div>`;
    }

    const groups = {};
    qs.forEach(q => { (groups[q.subject] = groups[q.subject] || []).push(q); });

    return `
      <h1 class="page-title">我的收藏</h1>
      <p class="page-desc">共 ${qs.length} 道收藏题，可用于考前集中复习。</p>

      <div class="card">
        <div class="row-between">
          <span class="text-sm text-2">按学科分组</span>
          <button class="btn btn-primary" id="fPractice">练习收藏题（${qs.length}）</button>
        </div>
      </div>

      ${Object.entries(groups).map(([sub, list]) => `
        <div class="card">
          <div class="card-title"><span>${esc(sub)} <span class="text-3 text-sm">（${list.length} 题）</span></span></div>
          ${list.map(q => `
            <div class="list-item" style="align-items:flex-start">
              <div class="list-item-main">
                <div class="list-item-title" style="white-space:normal">${rich(q.stem)}</div>
                <div class="list-item-meta">
                  <span>${esc(q.chapter)}</span>
                  <span>${TYPE_LABEL[q.type]}</span>
                  <span>${DIFF_LABEL[q.difficulty]}</span>
                </div>
              </div>
              <div class="row" style="flex-shrink:0">
                <button class="btn btn-sm" data-detail="${q.id}">看解析</button>
                <button class="btn btn-sm" data-unfav="${q.id}">取消收藏</button>
              </div>
            </div>`).join("")}
        </div>`).join("")}`;
  }

  function bindFavorite() {
    const qs = S.favoriteList().map(byId).filter(Boolean);

    // 收藏为空时渲染的是空状态，不含 #fPractice（同 bindWrong 的问题）
    const fPractice = $("#fPractice");
    if (fPractice) fPractice.onclick = () => {
      state.practice = createSession(shuffle(qs), { title: "收藏题练习" });
      state.view = "practice";
      render();
    };

    $$("[data-detail]").forEach(b => {
      b.onclick = () => { const q = byId(b.dataset.detail); if (q) showQuestionModal(q); };
    });
    $$("[data-unfav]").forEach(b => {
      b.onclick = () => { S.toggleFavorite(b.dataset.unfav); toast("已取消收藏"); render(); };
    });
  }

  /* ============================================================
     十一、学习统计
     ============================================================ */
  function htmlStats() {
    const st = S.stats();
    const records = S.data.records;
    const subjects = [...new Set(BANK.map(q => q.subject))];

    const subStats = subjects.map(sub => {
      const qs = BANK.filter(q => q.subject === sub);
      const done = qs.filter(q => records[q.id]).length;
      let attempts = 0, correct = 0;
      qs.forEach(q => {
        const r = records[q.id];
        if (r) { attempts += r.attempts; correct += r.correct; }
      });
      return {
        sub, total: qs.length, done,
        acc: attempts ? Math.round((correct / attempts) * 100) : 0,
        pct: Math.round((done / qs.length) * 100)
      };
    }).sort((a, b) => b.pct - a.pct);

    /* 近 14 天 */
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const p = (n) => String(n).padStart(2, "0");
      const key = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
      days.push({ key, label: `${d.getMonth() + 1}/${d.getDate()}`, ...(S.data.daily[key] || { answered: 0, correct: 0 }) });
    }
    const maxDay = Math.max(1, ...days.map(d => d.answered));

    /* 薄弱章节 */
    const chapMap = {};
    BANK.forEach(q => {
      const r = records[q.id];
      if (!r) return;
      const key = q.subject + " · " + q.chapter;
      const m = chapMap[key] || { attempts: 0, correct: 0, wrong: 0 };
      m.attempts += r.attempts; m.correct += r.correct; m.wrong += r.wrong;
      chapMap[key] = m;
    });
    const weak = Object.entries(chapMap)
      .map(([k, m]) => ({ k, ...m, acc: m.attempts ? Math.round((m.correct / m.attempts) * 100) : 0 }))
      .filter(x => x.attempts >= 2)
      .sort((a, b) => a.acc - b.acc)
      .slice(0, 6);

    const exams = S.examList().slice(0, 10);

    return `
      <h1 class="page-title">学习统计</h1>
      <p class="page-desc">数据来自本机浏览器记录，用于观察薄弱环节与学习节奏。</p>

      <div class="grid grid-4 mb-16">
        <div class="stat-card"><div class="stat-value is-primary">${st.answered}</div><div class="stat-label">累计答题次数</div></div>
        <div class="stat-card"><div class="stat-value is-success">${st.accuracy}%</div><div class="stat-label">总正确率</div></div>
        <div class="stat-card"><div class="stat-value">${st.touched} / ${BANK.length}</div><div class="stat-label">已练题目 / 题库总量</div></div>
        <div class="stat-card"><div class="stat-value is-warn">${st.streakDays}</div><div class="stat-label">连续打卡天数</div></div>
      </div>

      <div class="card">
        <div class="card-title"><span>近 14 天答题量</span><span class="text-xs text-3">峰值 ${maxDay} 题 / 天</span></div>
        <div class="chart">
          ${days.map(d => `
            <div class="chart-col" title="${d.key}：答 ${d.answered} 题，对 ${d.correct} 题">
              <div class="chart-bar ${d.answered ? "" : "is-empty"}"
                   style="height:${Math.max(2, (d.answered / maxDay) * 100)}%"></div>
              <div class="chart-label">${d.label}</div>
            </div>`).join("")}
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span>学科掌握情况</span></div>
        ${subStats.map(s => `
          <div style="margin-bottom:14px">
            <div class="row-between" style="margin-bottom:5px">
              <span class="fw-600">${esc(s.sub)}</span>
              <span class="text-sm text-2">
                已练 ${s.done}/${s.total} · 正确率
                <span class="${s.acc >= 80 ? "text-success" : s.acc >= 60 ? "text-warn" : "text-danger"}">${s.acc}%</span>
              </span>
            </div>
            <div class="progress-bar">
              <div class="progress-fill" style="width:${s.pct}%;background:${s.acc >= 80 ? "var(--success)" : s.acc >= 60 ? "var(--warn)" : "var(--danger)"}"></div>
            </div>
          </div>`).join("")}
      </div>

      ${weak.length ? `
        <div class="card">
          <div class="card-title"><span>薄弱章节 TOP ${weak.length}</span><span class="text-xs text-3">正确率由低到高</span></div>
          ${weak.map(w => `
            <div class="list-item">
              <div class="list-item-main">
                <div class="list-item-title">${esc(w.k)}</div>
                <div class="list-item-meta">
                  <span>作答 ${w.attempts} 次</span><span>答对 ${w.correct}</span><span>答错 ${w.wrong}</span>
                </div>
              </div>
              <div class="fw-600 ${w.acc >= 60 ? "text-warn" : "text-danger"}">${w.acc}%</div>
            </div>`).join("")}
        </div>` : ""}

      <div class="card">
        <div class="card-title"><span>考试记录</span><span class="text-xs text-3">最近 ${exams.length} 次</span></div>
        ${exams.length ? exams.map(e => `
          <div class="list-item">
            <div class="list-item-main">
              <div class="list-item-title">${esc(e.subject)}</div>
              <div class="list-item-meta">
                <span>${fmtDate(e.at)}</span><span>${e.right}/${e.total} 题</span><span>用时 ${fmtTime(e.durationSec)}</span>
              </div>
            </div>
            <div class="fw-600 ${e.score >= 60 ? "text-success" : "text-danger"}">${e.score} 分</div>
          </div>`).join("")
        : `<div class="empty"><div class="empty-icon">📊</div><h3>暂无考试记录</h3></div>`}
      </div>

      <div class="card">
        <div class="card-title"><span>数据管理</span></div>
        <div class="row">
          <button class="btn" id="btnExport">导出学习数据</button>
          <button class="btn" id="btnImport">导入数据</button>
          <button class="btn btn-danger" id="btnReset">清空全部记录</button>
        </div>
        <p class="text-xs text-3 mt-12">导出的 JSON 可用于换设备同步或备份。</p>
      </div>`;
  }

  function bindStats() {
    $("#btnExport").onclick = () => {
      const blob = new Blob([S.exportJSON()], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `学而刷题-数据-${S.todayKey()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("已导出 JSON 文件");
    };

    $("#btnImport").onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          try { S.importJSON(reader.result); toast("导入成功"); render(); }
          catch { toast("导入失败：文件格式不正确"); }
        };
        reader.readAsText(file);
      };
      input.click();
    };

    $("#btnReset").onclick = () => {
      if (confirm("确定清空全部学习记录吗？包括错题本、收藏与统计，此操作不可恢复。")) {
        S.resetAll(); toast("已清空全部记录"); render();
      }
    };
  }

  /* ============================================================
     十二、设置
     ============================================================ */
  function htmlSettings() {
    const st = S.settings();
    const user = S.user;
    const online = window.Api && window.Api.online;
    const goal = S.goals();
    const gp = S.goalProgress();

    const accountCard = user ? `
      <div class="card">
        <div class="card-title"><span>账号</span><span class="text-xs text-3">已登录</span></div>
        <div class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">${esc(user.nickname || user.username)}</div>
            <div class="list-item-meta">
              <span>@${esc(user.username)}</span>
              <span>注册于 ${fmtDate(user.createdAt)}</span>
            </div>
          </div>
          <button class="btn btn-sm" id="setLogout">退出登录</button>
        </div>
        <p class="text-xs text-3 mt-12">
          学习进度会自动同步到服务端，换设备登录同一账号即可继续。
        </p>
      </div>` : `
      <div class="card">
        <div class="card-title"><span>账号</span><span class="text-xs text-3">未登录</span></div>
        <p class="text-sm text-2 mb-12">
          当前为<strong>本地模式</strong>，学习记录只保存在这个浏览器里。
          登录后可将进度同步到服务端，实现多设备共用。
        </p>
        <button class="btn btn-primary" id="setLogin">登录 / 注册</button>
      </div>`;

    const serverCard = `
      <div class="card">
        <div class="card-title">
          <span>服务端连接</span>
          <span class="mode-chip ${online ? "is-online" : online === false ? "is-offline" : ""}">
            ${online ? "已连接" : online === false ? "未连接" : "检测中"}
          </span>
        </div>
        <div class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">题库来源</div>
            <div class="list-item-meta">
              <span>${bankSource === "server" ? "服务端题库" : "内置题库（js/questions.js）"}</span>
              <span>${BANK.length} 道题</span>
            </div>
          </div>
          <button class="btn btn-sm" id="setRecheck">重新检测</button>
        </div>
        ${online === false ? `
          <p class="text-xs text-warn mt-12">
            未检测到服务端，当前使用内置题库与本地存储。
            启动服务端后可自动切换：<code>node server/server.js</code>
          </p>` : ""}
      </div>`;

    return `
      <h1 class="page-title">设置</h1>
      <p class="page-desc">偏好设置立即生效，并保存在本机浏览器中。</p>

      ${accountCard}
      ${serverCard}

      <div class="card">
        <div class="card-title">
          <span>每日目标</span>
          <span class="text-xs text-3">设定后首页会显示完成进度</span>
        </div>
        <div class="grid grid-2">
          <div class="field">
            <label for="setGoalQ">每天做题量（题）</label>
            <select class="select" id="setGoalQ">
              ${[0, 5, 10, 15, 20, 30, 40, 50, 80, 100].map(v =>
                `<option value="${v}" ${goal.dailyQuestions === v ? "selected" : ""}>${v === 0 ? "不设目标" : v + " 题"}</option>`
              ).join("")}
            </select>
          </div>
          <div class="field">
            <label for="setGoalM">每天学习时长（分钟）</label>
            <select class="select" id="setGoalM">
              ${[0, 10, 15, 20, 30, 45, 60, 90, 120].map(v =>
                `<option value="${v}" ${goal.dailyMinutes === v ? "selected" : ""}>${v === 0 ? "不设目标" : v + " 分钟"}</option>`
              ).join("")}
            </select>
          </div>
        </div>
        <div class="row-between mt-12">
          <span class="text-xs text-3">
            ${gp.hasGoal
              ? `今日进度：${gp.done} / ${gp.target} 题（${gp.percent}%）${gp.met ? " · 已达成 🎉" : ""}`
              : "未设目标时首页会提示你设定一个"}
          </span>
          <button class="btn btn-sm" id="goalReset">恢复默认（20 题）</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">做题偏好</div>
        <label class="checkbox-row">
          <input type="checkbox" id="setInstant" ${st.instantJudge ? "checked" : ""}>
          <span>练习模式即时判分
            <small>关闭后，练习也需点「提交本题」才显示对错</small>
          </span>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" id="setAutoNext" ${st.autoNext ? "checked" : ""}>
          <span>答对后自动跳到下一题
            <small>适合快速刷题；答错时会停留让你看解析</small>
          </span>
        </label>
      </div>

      <div class="card">
        <div class="card-title">外观</div>
        <div class="grid grid-2">
          <div class="field">
            <label for="setTheme">主题</label>
            <select class="select" id="setTheme">
              <option value="light" ${st.theme === "light" ? "selected" : ""}>浅色</option>
              <option value="dark" ${st.theme === "dark" ? "selected" : ""}>深色</option>
            </select>
          </div>
          <div class="field">
            <label for="setFont">字号</label>
            <select class="select" id="setFont">
              <option value="sm" ${st.fontSize === "sm" ? "selected" : ""}>小</option>
              <option value="md" ${st.fontSize === "md" ? "selected" : ""}>中</option>
              <option value="lg" ${st.fontSize === "lg" ? "selected" : ""}>大</option>
            </select>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">题库信息</div>
        <div class="grid grid-4">
          <div class="stat-card"><div class="stat-value is-primary">${BANK.length}</div><div class="stat-label">题目总数</div></div>
          <div class="stat-card"><div class="stat-value">${new Set(BANK.map(q => q.subject)).size}</div><div class="stat-label">学科数</div></div>
          <div class="stat-card"><div class="stat-value">${new Set(BANK.map(q => q.subject + q.chapter)).size}</div><div class="stat-label">章节数</div></div>
          <div class="stat-card"><div class="stat-value">${new Set(BANK.flatMap(q => q.knowledge || [])).size}</div><div class="stat-label">知识点数</div></div>
        </div>
        <div class="list-item mt-12">
          <div class="list-item-main">
            <div class="list-item-title">数学公式渲染</div>
            <div class="list-item-meta">
              <span>${window.Render && window.Render.hasKatex() ? "KaTeX 已加载，支持 $...$ 与 $$...$$ 公式" : "KaTeX 未加载，公式将显示为原文"}</span>
            </div>
          </div>
          <span class="tag ${window.Render && window.Render.hasKatex() ? "tag-success" : "tag-warn"}">
            ${window.Render && window.Render.hasKatex() ? "可用" : "降级"}
          </span>
        </div>
        <p class="text-sm text-3 mt-16">
          ${bankSource === "server"
            ? "题库由服务端提供，管理员可通过接口统一维护。"
            : "题库为内置静态数据（<code>js/questions.js</code>），启动服务端后将改用服务端题库。"}
        </p>
      </div>

      <div class="card">
        <div class="card-title">快捷键</div>
        <ul class="text-sm text-2" style="padding-left:20px;margin:0;line-height:2">
          <li><strong>H</strong>：返回首页</li>
          <li><strong>A / B / C / D</strong> 或 <strong>1 / 2 / 3 / 4</strong>：选择对应选项</li>
          <li><strong>← / →</strong>：上一题 / 下一题</li>
          <li><strong>Enter</strong>：填空题提交答案</li>
          <li><strong>Esc</strong>：关闭解析弹窗</li>
        </ul>
      </div>`;
  }

  function bindSettings() {
    /* 每日目标 */
    const gq = $("#setGoalQ"), gm = $("#setGoalM");
    if (gq) gq.onchange = () => {
      S.setGoals({ dailyQuestions: Number(gq.value) });
      const gp2 = S.goalProgress();
      toast(gp2.hasGoal ? `每日目标已设为 ${gp2.target} 题` : "已关闭每日题量目标");
      render();
    };
    if (gm) gm.onchange = () => {
      S.setGoals({ dailyMinutes: Number(gm.value) });
      toast(Number(gm.value) ? `每日时长目标已设为 ${gm.value} 分钟` : "已关闭时长目标");
      render();
    };
    const gReset = $("#goalReset");
    if (gReset) gReset.onclick = () => {
      S.setGoals({ dailyQuestions: 20, dailyMinutes: 0 });
      toast("已恢复默认目标：每天 20 题");
      render();
    };

    $("#setInstant").onchange = (e) => {
      S.setSetting("instantJudge", e.target.checked);
      toast(e.target.checked ? "已开启即时判分" : "已关闭即时判分");
    };
    $("#setAutoNext").onchange = (e) => {
      S.setSetting("autoNext", e.target.checked);
      toast(e.target.checked ? "答对后自动下一题" : "已关闭自动跳题");
    };
    $("#setTheme").onchange = (e) => { applyTheme(e.target.value); toast("主题已切换"); };
    $("#setFont").onchange = (e) => {
      S.setSetting("fontSize", e.target.value);
      document.documentElement.dataset.fontsize = e.target.value;
      toast("字号已调整");
    };

    const setLogin = $("#setLogin");
    if (setLogin) setLogin.onclick = () => { authMode = "login"; authError = ""; go("login"); };

    const setLogout = $("#setLogout");
    if (setLogout) setLogout.onclick = async () => {
      if (!confirm("确定退出登录吗？本地数据会保留。")) return;
      await window.Api.logout();
      S.detachUser();
      updateAuthUI();
      toast("已退出登录");
      render();
    };

    const recheck = $("#setRecheck");
    if (recheck) recheck.onclick = async () => {
      recheck.disabled = true;
      recheck.textContent = "检测中…";
      const ok = await window.Api.detect(true);
      if (ok) {
        const loaded = await loadServerBank();
        toast(loaded ? `已连接服务端题库（${BANK.length} 题）` : "服务端可用，但题库为空，继续使用内置题库");
      } else {
        toast("未检测到服务端，继续使用内置题库");
      }
      render();
    };
  }

  /* ============================================================
     十二·五、登录 / 注册
     ============================================================ */
  let authMode = "login";   // login | register
  let authError = "";

  function htmlLogin() {
    const isLogin = authMode === "login";
    return `
      <div class="auth-wrap">
        <div class="auth-card">
          <div class="auth-logo">学</div>
          <h1 class="auth-title">${isLogin ? "登录学而刷题" : "创建新账号"}</h1>
          <p class="auth-sub">
            ${isLogin ? "登录后可跨设备同步学习进度" : "注册后学习记录将保存到服务端"}
          </p>

          <div class="auth-tabs">
            <button class="auth-tab ${isLogin ? "is-active" : ""}" data-auth-tab="login">登录</button>
            <button class="auth-tab ${!isLogin ? "is-active" : ""}" data-auth-tab="register">注册</button>
          </div>

          ${authError ? `<div class="auth-error">${esc(authError)}</div>` : ""}

          <form id="authForm" autocomplete="on">
            <div class="field">
              <label for="authUsername">用户名</label>
              <input class="input" id="authUsername" name="username"
                     placeholder="3–20 位，支持中文、字母、数字、下划线"
                     autocomplete="username" required>
            </div>

            ${isLogin ? "" : `
              <div class="field">
                <label for="authNickname">昵称（可选）</label>
                <input class="input" id="authNickname" name="nickname"
                       placeholder="显示在右上角，留空则用用户名" autocomplete="nickname">
              </div>`}

            <div class="field">
              <label for="authPassword">密码</label>
              <input class="input" id="authPassword" name="password" type="password"
                     placeholder="至少 6 位" autocomplete="${isLogin ? "current-password" : "new-password"}" required>
            </div>

            ${isLogin ? "" : `
              <div class="field">
                <label for="authPassword2">确认密码</label>
                <input class="input" id="authPassword2" name="password2" type="password"
                       placeholder="再输入一次" autocomplete="new-password" required>
              </div>`}

            <button class="btn btn-primary btn-block btn-lg mt-8" id="authSubmit" type="submit">
              ${isLogin ? "登录" : "注册并登录"}
            </button>
          </form>

          <div class="auth-divider">或</div>

          <button class="btn btn-block" id="authSkip">先以本地模式使用（不登录）</button>

          <p class="auth-hint">
            ${isLogin
              ? "还没有账号？点上方「注册」标签即可创建。"
              : "已有账号？点上方「登录」标签。"}
            <br>本地模式下数据仅保存在当前浏览器。
          </p>
        </div>
      </div>`;
  }

  function bindLogin() {
    $$("[data-auth-tab]").forEach(t => {
      t.onclick = () => {
        authMode = t.dataset.authTab;
        authError = "";
        render();
        setTimeout(() => { const i = $("#authUsername"); if (i) i.focus(); }, 50);
      };
    });

    $("#authSkip").onclick = () => {
      authError = "";
      go("home");
      toast("已进入本地模式，数据保存在浏览器中");
    };

    $("#authForm").onsubmit = async (e) => {
      e.preventDefault();
      const username = $("#authUsername").value.trim();
      const password = $("#authPassword").value;
      const nickname = $("#authNickname") ? $("#authNickname").value.trim() : "";

      if (!username || !password) { authError = "请填写用户名和密码"; render(); return; }
      if (authMode === "register") {
        const p2 = $("#authPassword2") ? $("#authPassword2").value : "";
        if (password !== p2) { authError = "两次输入的密码不一致"; render(); return; }
      }

      const btn = $("#authSubmit");
      btn.disabled = true;
      btn.textContent = authMode === "login" ? "登录中…" : "注册中…";

      try {
        const user = authMode === "login"
          ? await window.Api.login(username, password)
          : await window.Api.register(username, password, nickname);

        await afterAuthSuccess(user);
      } catch (err) {
        authError = err.message || "操作失败，请重试";
        render();
      }
    };

    setTimeout(() => { const i = $("#authUsername"); if (i) i.focus(); }, 50);
  }

  /** 登录/注册成功后的统一处理 */
  async function afterAuthSuccess(user) {
    authError = "";
    toast(`欢迎，${user.nickname || user.username}！`);
    const r = await S.attachUser(user);
    updateAuthUI();
    go("home");
    if (r && r.merged && r.remoteHadData) {
      setTimeout(() => toast("已合并云端学习进度", 2600), 1200);
    }
  }

  /* ============================================================
     十二·六、账号 UI 状态
     ============================================================ */
  function updateAuthUI() {
    const user = S.user;
    const loginBtn = $("#loginBtn");
    const chip = $("#userChip");
    if (!loginBtn || !chip) return;

    if (user) {
      loginBtn.classList.add("hidden");
      chip.classList.remove("hidden");
      const name = user.nickname || user.username;
      $("#userName").textContent = name;
      $("#userAvatar").textContent = name.slice(0, 1).toUpperCase();
      $("#menuNickname").textContent = name;
      $("#menuUsername").textContent = "@" + user.username;
    } else {
      loginBtn.classList.remove("hidden");
      chip.classList.add("hidden");
      const menu = $("#userMenu");
      if (menu) menu.classList.add("hidden");
    }
    updateModeChip();
  }

  /** 顶部数据模式标识 + 页脚说明 */
  function updateModeChip() {
    const chip = $("#modeChip");
    const footerMode = $("#footerMode");
    if (!chip) return;

    const online = window.Api && window.Api.online;
    const loggedIn = !!S.user;

    if (online === false) {
      chip.textContent = "本地模式";
      chip.className = "mode-chip is-offline";
      chip.title = "未连接服务端，数据保存在浏览器本地";
      if (footerMode) footerMode.textContent = "本地模式 · 数据保存在浏览器本地";
    } else if (loggedIn) {
      chip.textContent = "云端同步";
      chip.className = "mode-chip is-online";
      chip.title = "已登录，学习进度自动同步到服务端";
      if (footerMode) footerMode.textContent = "已登录 · 学习进度自动同步到服务端";
    } else {
      chip.textContent = "本地模式";
      chip.className = "mode-chip";
      chip.title = "未登录，数据仅保存在浏览器本地";
      if (footerMode) footerMode.textContent = "未登录 · 数据保存在浏览器本地";
    }
  }

  function bindAuthUI() {
    const loginBtn = $("#loginBtn");
    if (loginBtn) loginBtn.onclick = () => { authMode = "login"; authError = ""; go("login"); };

    const menuBtn = $("#userMenuBtn");
    const menu = $("#userMenu");
    if (menuBtn && menu) {
      menuBtn.onclick = (e) => { e.stopPropagation(); menu.classList.toggle("hidden"); };
      document.addEventListener("click", () => menu.classList.add("hidden"));
      menu.onclick = (e) => e.stopPropagation();
    }

    const syncBtn = $("#syncNow");
    if (syncBtn) syncBtn.onclick = async () => {
      const ok = await S.syncNow();
      toast(ok ? "进度已同步到服务端 ✅" : "同步失败，请检查网络或登录状态");
    };

    const logoutBtn = $("#logoutBtn");
    if (logoutBtn) logoutBtn.onclick = async () => {
      if (!confirm("确定退出登录吗？本地数据会保留。")) return;
      await window.Api.logout();
      S.detachUser();
      updateAuthUI();
      toast("已退出登录");
      go("home");
    };

    /* 同步状态小圆点 */
    S.onSync((st) => {
      const chip = $("#modeChip");
      if (!chip || !S.user) return;
      chip.textContent = st === "saving" ? "同步中…" : st === "error" ? "同步失败" : "云端同步";
      chip.className = "mode-chip " + (st === "error" ? "is-offline" : "is-online");
    });

    /* 左上角返回首页按钮 */
    const homeBtn = $("#homeBtn");
    if (homeBtn) {
      homeBtn.onclick = () => {
        const sess = currentSession();
        if (sess && !sess.finished && state.view === "exam") {
          if (!confirm("当前有未交卷的模拟考试，确定返回首页吗？本次作答将丢失。")) return;
          state.exam = null;
        }
        state.practice = null;
        state.lastExamResult = null;
        clearInterval(examTimerId);
        go("home");
        toast("已返回首页");
      };
    }
  }

  /* ============================================================
     十二·七、今日复习（间隔重复）
     ============================================================ */
  function htmlReview() {
    const dueIds = S.dueList().map(byId).filter(Boolean);
    const allReview = S.data.review || {};
    const tracked = Object.keys(allReview).length;

    if (!tracked) {
      return `
        <h1 class="page-title">今日复习</h1>
        <p class="page-desc">基于艾宾浩斯遗忘曲线的间隔重复：答对的题间隔逐渐拉长，答错的题尽快重练。</p>
        <div class="card">
          <div class="empty">
            <div class="empty-icon">🧠</div>
            <h3>还没有复习计划</h3>
            <p class="text-sm">做几道题后，系统会自动为每道题安排复习时间</p>
            <button class="btn btn-primary mt-16" data-nav="practice">去练习</button>
          </div>
        </div>`;
    }

    /* 未来 7 天的到期分布 */
    const now = Date.now();
    const DAY = 86400000;
    const upcoming = [];
    for (let d = 0; d < 7; d++) {
      const start = now + d * DAY;
      const end = start + DAY;
      const n = Object.values(allReview).filter(r => r.dueAt > (d === 0 ? -Infinity : start) && r.dueAt <= end).length;
      upcoming.push({ day: d, n });
    }

    /* 已掌握（阶段 >= 4，即间隔 ≥16 天） */
    const mastered = Object.values(allReview).filter(r => (r.stage || 0) >= 4).length;
    const learning = tracked - mastered;

    if (!dueIds.length) {
      return `
        <h1 class="page-title">今日复习</h1>
        <p class="page-desc">基于艾宾浩斯遗忘曲线的间隔重复调度。</p>

        <div class="card">
          <div class="empty">
            <div class="empty-icon">✅</div>
            <h3>今天没有需要复习的题目</h3>
            <p class="text-sm">已掌握 ${mastered} 题，学习中 ${learning} 题。继续保持！</p>
            <div class="row mt-16" style="justify-content:center">
              <button class="btn btn-primary" data-nav="practice">做新题</button>
              <button class="btn" id="rvPreview">提前复习（${Math.min(10, learning)} 题）</button>
            </div>
          </div>
        </div>

        ${reviewScheduleCard(upcoming, mastered, learning, tracked)}`;
    }

    return `
      <h1 class="page-title">今日复习</h1>
      <p class="page-desc">共 ${dueIds.length} 题到期。答对后间隔会拉长，答错则很快再次出现。</p>

      <div class="due-banner">
        <div class="due-banner-main">
          <span class="due-banner-icon">🔔</span>
          <div class="due-banner-text">
            <strong>今天有 ${dueIds.length} 道题需要复习</strong>
            <span>趁热打铁，复习效率最高</span>
          </div>
        </div>
        <button class="btn btn-primary" id="rvStart">开始复习</button>
      </div>

      ${reviewScheduleCard(upcoming, mastered, learning, tracked)}

      <div class="card">
        <div class="card-title">
          <span>待复习题目（${dueIds.length}）</span>
          <span class="text-xs text-3">按到期时间排序</span>
        </div>
        ${dueIds.map(q => {
          const r = allReview[q.id] || {};
          const rec = S.getRecord(q.id);
          return `
            <div class="list-item" style="align-items:flex-start">
              <div class="list-item-main">
                <div class="list-item-title" style="white-space:normal">${rich(q.stem)}</div>
                <div class="list-item-meta">
                  <span>${esc(q.subject)}</span>
                  <span>${esc(q.chapter)}</span>
                  <span class="review-chip is-due">第 ${(r.stage || 0) + 1} 阶段</span>
                  ${r.lapses ? `<span class="review-chip">遗忘 ${r.lapses} 次</span>` : ""}
                  ${rec ? `<span>作答 ${rec.attempts} 次</span>` : ""}
                </div>
              </div>
              <button class="btn btn-sm" data-detail="${q.id}">看解析</button>
            </div>`;
        }).join("")}
      </div>`;
  }

  /** 复习计划概览卡片 */
  function reviewScheduleCard(upcoming, mastered, learning, tracked) {
    const max = Math.max(1, ...upcoming.map(u => u.n));
    return `
      <div class="card">
        <div class="card-title">
          <span>复习计划</span>
          <span class="text-xs text-3">共跟踪 ${tracked} 题</span>
        </div>
        <div class="grid grid-3 mb-16">
          <div class="stat-card"><div class="stat-value is-warn">${upcoming[0].n}</div><div class="stat-label">今天到期</div></div>
          <div class="stat-card"><div class="stat-value is-primary">${learning}</div><div class="stat-label">学习中</div></div>
          <div class="stat-card"><div class="stat-value is-success">${mastered}</div><div class="stat-label">已掌握</div></div>
        </div>
        <div class="chart" style="height:100px">
          ${upcoming.map(u => `
            <div class="chart-col" title="${u.day === 0 ? "今天" : u.day + " 天后"}：${u.n} 题">
              <div class="chart-bar ${u.n ? "" : "is-empty"}" style="height:${Math.max(2, (u.n / max) * 100)}%"></div>
              <div class="chart-label">${u.day === 0 ? "今天" : "+" + u.day}</div>
            </div>`).join("")}
        </div>
        <p class="text-xs text-3 mt-12">
          间隔重复：答对后复习间隔按 1 → 3 → 7 → 16 → 35 天递增；答错则回退到 1 天内重练。
        </p>
      </div>`;
  }

  function bindReview() {
    const dueIds = S.dueList().map(byId).filter(Boolean);

    const start = $("#rvStart");
    if (start) start.onclick = () => {
      if (!dueIds.length) return;
      state.practice = createSession(dueIds, { title: "今日复习" });
      state.view = "practice";
      render();
    };

    const preview = $("#rvPreview");
    if (preview) preview.onclick = () => {
      const all = S.data.review || {};
      const list = Object.keys(all)
        .map(byId).filter(Boolean)
        .sort((a, b) => (all[a.id].dueAt || 0) - (all[b.id].dueAt || 0))
        .slice(0, 10);
      if (!list.length) { toast("暂无可复习的题目"); return; }
      state.practice = createSession(list, { title: "提前复习" });
      state.view = "practice";
      render();
    };

    $$("[data-detail]").forEach(b => {
      b.onclick = () => { const q = byId(b.dataset.detail); if (q) showQuestionModal(q); };
    });
  }

  /* ============================================================
     十二·八、知识点掌握度
     ============================================================ */
  /** 汇总每个知识点的题量、已练数、正确率 */
  function knowledgeStats() {
    const records = S.data.records;
    const map = {};
    BANK.forEach(q => {
      (q.knowledge || [q.chapter]).forEach(k => {
        if (!map[k]) map[k] = { tag: k, total: 0, done: 0, attempts: 0, correct: 0, subjects: new Set() };
        const m = map[k];
        m.total += 1;
        m.subjects.add(q.subject);
        const r = records[q.id];
        if (r) { m.done += 1; m.attempts += r.attempts; m.correct += r.correct; }
      });
    });
    return Object.values(map).map(m => ({
      ...m,
      subjects: [...m.subjects],
      acc: m.attempts ? Math.round((m.correct / m.attempts) * 100) : null
    })).sort((a, b) => {
      // 未练的排后，其余按正确率升序（薄弱在前）
      if (a.acc === null && b.acc === null) return b.total - a.total;
      if (a.acc === null) return 1;
      if (b.acc === null) return -1;
      return a.acc - b.acc;
    });
  }

  function htmlKnowledge() {
    const stats = knowledgeStats();
    const practiced = stats.filter(s => s.acc !== null);
    const weak = practiced.filter(s => s.acc < 60);
    const mid = practiced.filter(s => s.acc >= 60 && s.acc < 85);
    const good = practiced.filter(s => s.acc >= 85);

    if (!practiced.length) {
      return `
        <h1 class="page-title">知识点掌握度</h1>
        <p class="page-desc">按知识点统计掌握情况，比「章节」更精细地定位薄弱环节。</p>
        <div class="card">
          <div class="empty">
            <div class="empty-icon">🎯</div>
            <h3>还没有练习数据</h3>
            <p class="text-sm">做几道题后，这里会显示每个知识点的掌握程度</p>
            <button class="btn btn-primary mt-16" data-nav="practice">去练习</button>
          </div>
        </div>
        <div class="card">
          <div class="card-title"><span>全部知识点（${stats.length}）</span></div>
          <div class="knowledge-cloud">
            ${stats.map(s => `<span class="knowledge-pill" data-tag="${esc(s.tag)}">${esc(s.tag)}<span class="kp-count">${s.total}</span></span>`).join("")}
          </div>
        </div>`;
    }

    return `
      <h1 class="page-title">知识点掌握度</h1>
      <p class="page-desc">共 ${stats.length} 个知识点，已练 ${practiced.length} 个。点击知识点可直接针对性练习。</p>

      <div class="grid grid-3 mb-16">
        <div class="stat-card"><div class="stat-value is-danger">${weak.length}</div><div class="stat-label">薄弱知识点（&lt;60%）</div></div>
        <div class="stat-card"><div class="stat-value is-warn">${mid.length}</div><div class="stat-label">待巩固（60–85%）</div></div>
        <div class="stat-card"><div class="stat-value is-success">${good.length}</div><div class="stat-label">已掌握（≥85%）</div></div>
      </div>

      ${weak.length ? `
        <div class="card">
          <div class="card-title">
            <span>薄弱知识点</span>
            <button class="btn btn-sm btn-primary" id="knWeakPractice">专项练习（${weak.length}）</button>
          </div>
          ${weak.map(s => `
            <div class="list-item">
              <div class="list-item-main">
                <div class="list-item-title">${esc(s.tag)}</div>
                <div class="list-item-meta">
                  <span>${esc(s.subjects.join("、"))}</span>
                  <span>已练 ${s.done}/${s.total} 题</span>
                  <span>作答 ${s.attempts} 次</span>
                </div>
              </div>
              <div class="row">
                <span class="fw-600 text-danger">${s.acc}%</span>
                <button class="btn btn-sm" data-tag-practice="${esc(s.tag)}">练习</button>
              </div>
            </div>`).join("")}
        </div>` : ""}

      <div class="card">
        <div class="card-title"><span>知识点热力图</span><span class="text-xs text-3">颜色越红越薄弱</span></div>
        <div class="knowledge-cloud">
          ${stats.map(s => {
            const cls = s.acc === null ? "" : s.acc < 60 ? "is-weak" : s.acc < 85 ? "is-mid" : "is-good";
            const label = s.acc === null ? "未练" : s.acc + "%";
            return `<span class="knowledge-pill ${cls}" data-tag="${esc(s.tag)}" title="${esc(s.tag)}：${label}（${s.done}/${s.total} 题）">
              ${esc(s.tag)}<span class="kp-count">${s.acc === null ? s.total : s.acc + "%"}</span>
            </span>`;
          }).join("")}
        </div>
        <div class="sheet-legend mt-16">
          <span><i style="background:var(--danger-weak);border:1px solid var(--danger)"></i>薄弱 &lt;60%</span>
          <span><i style="background:var(--warn-weak);border:1px solid var(--warn)"></i>待巩固 60–85%</span>
          <span><i style="background:var(--success-weak);border:1px solid var(--success)"></i>已掌握 ≥85%</span>
          <span><i style="background:var(--bg-sub);border:1px solid var(--border)"></i>未练习</span>
        </div>
      </div>

      <div class="card">
        <div class="card-title"><span>按学科查看知识点</span></div>
        ${Object.entries(stats.reduce((acc, s) => {
          s.subjects.forEach(sub => { (acc[sub] = acc[sub] || []).push(s); });
          return acc;
        }, {})).map(([sub, list]) => `
          <div style="margin-bottom:14px">
            <div class="fw-600 mb-8">${esc(sub)} <span class="text-3 text-sm">（${list.length} 个知识点）</span></div>
            <div class="knowledge-cloud">
              ${list.map(s => {
                const cls = s.acc === null ? "" : s.acc < 60 ? "is-weak" : s.acc < 85 ? "is-mid" : "is-good";
                return `<span class="knowledge-pill ${cls}" data-tag="${esc(s.tag)}">${esc(s.tag)}<span class="kp-count">${s.acc === null ? "未练" : s.acc + "%"}</span></span>`;
              }).join("")}
            </div>
          </div>`).join("")}
      </div>`;
  }

  function bindKnowledge() {
    const stats = knowledgeStats();

    /** 按知识点开一组练习 */
    function practiceByTags(tags, title) {
      const list = BANK.filter(q => (q.knowledge || []).some(k => tags.includes(k)));
      if (!list.length) { toast("该知识点暂无题目"); return; }
      state.practice = createSession(shuffle(list), { title });
      state.view = "practice";
      render();
    }

    $$("[data-tag-practice]").forEach(b => {
      b.onclick = (e) => { e.stopPropagation(); practiceByTags([b.dataset.tagPractice], `专项练习 · ${b.dataset.tagPractice}`); };
    });

    $$("[data-tag]").forEach(el => {
      el.onclick = () => practiceByTags([el.dataset.tag], `专项练习 · ${el.dataset.tag}`);
    });

    const weakBtn = $("#knWeakPractice");
    if (weakBtn) weakBtn.onclick = () => {
      const weakTags = stats.filter(s => s.acc !== null && s.acc < 60).map(s => s.tag);
      practiceByTags(weakTags, "薄弱知识点专项练习");
    };
  }

  /* ============================================================
     十二·九、个人笔记
     ============================================================ */
  function htmlNotes() {
    const ids = S.noteList().map(byId).filter(Boolean);

    if (!ids.length) {
      return `
        <h1 class="page-title">我的笔记</h1>
        <p class="page-desc">做题时记录易错点与思路，复习时会自动显示，笔记随账号同步。</p>
        <div class="card">
          <div class="empty">
            <div class="empty-icon">📝</div>
            <h3>还没有笔记</h3>
            <p class="text-sm">答题时点右上角「📝 笔记」即可为这道题写下你的理解</p>
            <button class="btn btn-primary mt-16" data-nav="practice">去练习</button>
          </div>
        </div>`;
    }

    /* 按学科分组 */
    const groups = {};
    ids.forEach(q => { (groups[q.subject] = groups[q.subject] || []).push(q); });

    return `
      <h1 class="page-title">我的笔记</h1>
      <p class="page-desc">共 ${ids.length} 条笔记，按学科分组。点击「编辑」可修改，删除后其他设备同步生效。</p>

      <div class="card">
        <div class="row-between">
          <span class="text-sm text-2">笔记会随账号同步到其他设备</span>
          <button class="btn btn-primary" id="ntPractice">练习有笔记的题（${ids.length}）</button>
        </div>
      </div>

      ${Object.entries(groups).map(([sub, list]) => `
        <div class="card">
          <div class="card-title"><span>${esc(sub)} <span class="text-3 text-sm">（${list.length} 条）</span></span></div>
          ${list.map(q => {
            const n = S.data.notes[q.id] || {};
            const rec = S.getRecord(q.id);
            return `
              <div class="list-item" style="align-items:flex-start">
                <div class="list-item-main">
                  <div class="list-item-title" style="white-space:normal">${rich(q.stem)}</div>
                  <div class="note-body">${esc(n.text || "")}</div>
                  <div class="list-item-meta">
                    <span>${esc(q.chapter)}</span>
                    ${(q.knowledge || []).slice(0, 2).map(k => `<span class="tag tag-knowledge">${esc(k)}</span>`).join("")}
                    <span>更新于 ${fmtDate(n.updatedAt || 0)}</span>
                    ${rec ? `<span>作答 ${rec.attempts} 次</span>` : ""}
                  </div>
                </div>
                <div class="row" style="flex-shrink:0">
                  <button class="btn btn-sm" data-note-edit="${q.id}">编辑</button>
                  <button class="btn btn-sm" data-note-del="${q.id}">删除</button>
                </div>
              </div>`;
          }).join("")}
        </div>`).join("")}`;
  }

  function bindNotes() {
    const ids = S.noteList().map(byId).filter(Boolean);

    const p = $("#ntPractice");
    if (p) p.onclick = () => {
      state.practice = createSession(shuffle(ids), { title: "笔记题复习" });
      state.view = "practice";
      render();
    };

    $$("[data-note-edit]").forEach(b => {
      b.onclick = () => {
        const q = byId(b.dataset.noteEdit);
        if (q) openNoteEditor(q);
      };
    });

    $$("[data-note-del]").forEach(b => {
      b.onclick = () => {
        if (confirm("确定删除这条笔记吗？删除后会同步到其他设备。")) {
          S.deleteNote(b.dataset.noteDel);
          toast("笔记已删除");
          render();
        }
      };
    });
  }

  /**
   * 打开笔记编辑弹窗。
   * @param {object} q 题目
   */
  function openNoteEditor(q) {
    const existing = S.getNote(q.id);
    const mask = document.createElement("div");
    mask.className = "modal-mask";
    mask.innerHTML = `
      <div class="modal">
        <div class="quiz-tags mb-12">
          <span class="tag tag-primary">${esc(q.subject)}</span>
          <span class="tag">${esc(q.chapter)}</span>
        </div>
        <h3 style="font-size:15.5px;line-height:1.7">${rich(q.stem)}</h3>
        <div class="field mt-16">
          <label for="noteText">我的笔记</label>
          <textarea class="textarea" id="noteText" maxlength="2000"
            placeholder="记下易错点、解题思路、公式推导…（支持 $公式$）">${esc(existing ? existing.text : "")}</textarea>
          <div class="row-between mt-8">
            <span class="text-xs text-3">支持 LaTeX 公式，最多 2000 字</span>
            <span class="text-xs text-3" id="noteCount"></span>
          </div>
        </div>
        <div class="modal-actions">
          ${existing ? '<button class="btn btn-danger" data-note-clear>清空笔记</button>' : ""}
          <button class="btn" data-close>取消</button>
          <button class="btn btn-primary" data-save>保存</button>
        </div>
      </div>`;
    document.body.appendChild(mask);

    const ta = $("#noteText", mask);
    const counter = $("#noteCount", mask);
    const updateCount = () => { counter.textContent = `${ta.value.length} / 2000`; };
    updateCount();
    ta.oninput = updateCount;
    ta.onkeydown = (e) => {
      // Ctrl/Cmd + Enter 快速保存
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
    };

    const close = () => { mask.remove(); document.removeEventListener("keydown", onEsc); };
    const onEsc = (e) => { if (e.key === "Escape") close(); };

    function save() {
      const text = ta.value;
      S.saveNote(q.id, text);
      close();
      toast(text.trim() ? "笔记已保存" : "笔记已清空");
      render();
    }

    $("[data-save]", mask).onclick = save;
    $("[data-close]", mask).onclick = close;
    const clearBtn = $("[data-note-clear]", mask);
    if (clearBtn) clearBtn.onclick = () => {
      ta.value = "";
      updateCount();
      save();
    };
    mask.onclick = (e) => { if (e.target === mask) close(); };
    document.addEventListener("keydown", onEsc);

    setTimeout(() => ta.focus(), 60);
  }

  /* ============================================================
     十二·十、每日目标
     ============================================================ */
  /**
   * 渲染今日目标进度环（SVG）。
   * 用 stroke-dasharray 画环，比 conic-gradient 更易做圆角端点。
   */
  function goalRing(gp, size = 128) {
    const r = (size - 16) / 2;
    const c = 2 * Math.PI * r;
    const pct = gp.hasGoal ? gp.percent : 0;
    const offset = c * (1 - pct / 100);
    const color = !gp.hasGoal ? "var(--text-3)"
      : gp.met ? "var(--success)"
      : pct >= 60 ? "var(--primary)" : "var(--warn)";

    return `
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="goal-ring">
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}"
                fill="none" stroke="var(--bg-sub)" stroke-width="10"/>
        <circle cx="${size / 2}" cy="${size / 2}" r="${r}"
                fill="none" stroke="${color}" stroke-width="10"
                stroke-linecap="round"
                stroke-dasharray="${c.toFixed(1)}"
                stroke-dashoffset="${offset.toFixed(1)}"
                transform="rotate(-90 ${size / 2} ${size / 2})"
                style="transition:stroke-dashoffset .5s"/>
        <text x="50%" y="46%" text-anchor="middle" dominant-baseline="middle"
              style="font-size:26px;font-weight:700;fill:${color}">
          ${gp.hasGoal ? gp.done : "—"}
        </text>
        <text x="50%" y="66%" text-anchor="middle" dominant-baseline="middle"
              style="font-size:12px;fill:var(--text-3)">
          ${gp.hasGoal ? "目标 " + gp.target : "未设目标"}
        </text>
      </svg>`;
  }

  /** 首页的目标卡片 */
  function goalCard(gp) {
    if (!gp.hasGoal) {
      return `
        <div class="card goal-card">
          <div class="goal-main">
            ${goalRing(gp, 110)}
            <div class="goal-info">
              <strong>还没有设置每日目标</strong>
              <span>设定每天练几道题，能显著提升坚持率。</span>
              <div class="row mt-12">
                <button class="btn btn-primary btn-sm" id="goalQuick20">设为每天 20 题</button>
                <button class="btn btn-sm" data-nav="settings">自定义</button>
              </div>
            </div>
          </div>
        </div>`;
    }

    const pct = gp.percent;
    const msg = gp.met
      ? "今日目标已达成，很棒！🎉"
      : `还差 ${gp.remain} 题达成今日目标`;

    return `
      <div class="card goal-card ${gp.met ? "is-met" : ""}">
        <div class="goal-main">
          ${goalRing(gp, 110)}
          <div class="goal-info">
            <strong>${msg}</strong>
            <span>
              今日已答 ${gp.done} 题 · 正确率 ${gp.accuracy}%
              ${gp.correct ? `（答对 ${gp.correct} 题）` : ""}
            </span>
            <div class="progress-bar mt-12" style="max-width:320px">
              <div class="progress-fill" style="width:${pct}%;background:${gp.met ? "var(--success)" : "var(--primary)"}"></div>
            </div>
            <div class="row mt-12">
              ${gp.met
                ? `<button class="btn btn-sm" data-nav="practice">继续加练</button>
                   <button class="btn btn-sm" data-nav="review">今日复习${S.dueCount() ? "（" + S.dueCount() + "）" : ""}</button>`
                : `<button class="btn btn-primary btn-sm" data-nav="practice">继续刷题</button>
                   <button class="btn btn-sm" data-nav="settings">调整目标</button>`}
            </div>
          </div>
        </div>
      </div>`;
  }

  /** 近 14 天目标达成日历 */
  function goalCalendar() {
    const hist = S.goalHistory(14);
    const gp = S.goalProgress();
    if (!gp.hasGoal) return "";

    const metDays = hist.filter(h => h.met).length;
    return `
      <div class="card">
        <div class="card-title">
          <span>目标达成情况</span>
          <span class="text-xs text-3">近 14 天达成 ${metDays} 天</span>
        </div>
        <div class="goal-calendar">
          ${hist.map(h => `
            <div class="gc-day ${h.met ? "is-met" : h.answered ? "is-part" : ""}"
                 title="${h.key}：答 ${h.answered} 题，正确 ${h.correct} 题">
              <span class="gc-label">${h.label}</span>
              <span class="gc-count">${h.answered || ""}</span>
            </div>`).join("")}
        </div>
        <p class="text-xs text-3 mt-12">
          绿色表示当天达成目标（${gp.target} 题），黄色表示有练习但未达标。
        </p>
      </div>`;
  }

  /* ============================================================
     十三、主题
     ============================================================ */
  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    document.body.dataset.theme = theme;
    S.setSetting("theme", theme);
    const btn = $("#themeToggle");
    if (btn) btn.textContent = theme === "dark" ? "☀️" : "🌙";
  }

  function initTheme() {
    const st = S.settings();
    applyTheme(st.theme || "light");
    document.documentElement.dataset.fontsize = st.fontSize || "md";
    $("#themeToggle").onclick = () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme(next);
      toast(next === "dark" ? "已切换到深色模式" : "已切换到浅色模式");
    };
  }

  /* ============================================================
     十四、键盘快捷键
     ============================================================ */
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    const typing = tag === "input" || tag === "textarea" || tag === "select";

    /* H：返回首页（输入框内不触发） */
    if (!typing && (e.key === "h" || e.key === "H") && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const homeBtn = $("#homeBtn");
      if (homeBtn && state.view !== "home") { e.preventDefault(); homeBtn.click(); }
      return;
    }

    const sess = currentSession();
    if (!sess) return;
    if (typing) return;
    if (e.target.closest && e.target.closest(".modal-mask")) return;

    const q = sess.questions[sess.index];
    const judged = state.view === "practice" && sess.judged[sess.index];
    if (judged) return;

    const keyMap = { a: 0, b: 1, c: 2, d: 3, e: 4, f: 5, "1": 0, "2": 1, "3": 2, "4": 3, "5": 4, "6": 5 };
    const idx = keyMap[e.key.toLowerCase()];

    if (idx !== undefined && q.type !== "fill" && idx < q.options.length) {
      const btn = $(`[data-opt="${idx}"]`);
      if (btn) btn.click();
      return;
    }
    if (e.key === "ArrowRight") {
      const b = $("#btnNext");
      if (b) { e.preventDefault(); b.click(); }
    } else if (e.key === "ArrowLeft") {
      const b = $("#btnPrev");
      if (b && !b.disabled) { e.preventDefault(); b.click(); }
    }
  });

  /* ============================================================
     十五、启动
     ============================================================ */

  /** 尝试从服务端加载题库；失败则继续用内置题库 */
  async function loadServerBank() {
    try {
      const ok = await window.Api.detect();
      if (!ok) return false;

      // 分页拉取全部题目（服务端可能很大，避免单次响应过大）
      const PAGE = 500;
      let all = [], offset = 0, total = Infinity;

      while (all.length < total) {
        const r = await window.Api.fetchQuestions({ limit: PAGE, offset });
        total = r.total;
        all = all.concat(r.questions);
        if (!r.questions.length) break;
        offset += r.questions.length;
      }

      if (all.length) {
        BANK = all;
        bankSource = "server";
        try { serverMeta = await window.Api.fetchMeta(); } catch { /* 元信息非必需 */ }
        return true;
      }
    } catch (e) {
      console.warn("加载服务端题库失败，改用内置题库：", e.message);
    }
    return false;
  }

  /** 恢复已保存的登录会话 */
  async function restoreSession() {
    try {
      const user = await window.Api.me();
      if (user) await S.attachUser(user);
      return user;
    } catch {
      return null;
    }
  }

  async function init() {
    initTheme();
    render();                       // 先用内置题库立即渲染，避免白屏

    // 并行探测服务端：题库 + 会话
    const [bankOk, user] = await Promise.all([loadServerBank(), restoreSession()]);

    updateAuthUI();
    updateFooter();

    // 题库来源变化时刷新首页统计文案
    if (bankOk && state.view === "home") render();

    if (bankOk && user) {
      toast(`已连接服务端 · 题库 ${BANK.length} 题 · 已登录`, 2800);
    } else if (bankOk) {
      toast(`已连接服务端题库，共 ${BANK.length} 题`, 2600);
    }
  }

  init();
})();
