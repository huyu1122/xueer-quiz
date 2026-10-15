"use strict";
/**
 * 学而刷题 —— 服务端
 * 零依赖 Node HTTP 服务：静态托管前端 + REST API（认证 / 题库 / 学习进度）。
 *
 * 启动方式（推荐用启动器，会自动开浏览器）：
 *   Windows 双击：启动刷题系统.cmd
 *   命令行：      node server/server.js [--port 3000] [--no-open]
 *
 * 特性：
 *   - 端口被占用时自动顺延，无需手动改配置
 *   - 启动后自动打开浏览器
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");
const zlib = require("zlib");
const { spawn } = require("child_process");

const db = require("./db");
const auth = require("./auth");
const Compress = require("./compress");
const RateLimit = require("./ratelimit");

/**
 * 构造会话 Cookie。
 * - HttpOnly：阻止 JS 读取，降低 XSS 窃取风险
 * - SameSite=Lax：阻止跨站 POST 携带（CSRF 基础防护）
 * - Secure：仅在 HTTPS 下添加，否则本地 http 会无法写入 Cookie
 *   （用 QUIZ_SECURE_COOKIE=1 显式开启，或检测到 HTTPS 代理时自动开启）
 */
function sessionCookie(token, maxAgeSec) {
  const parts = [
    `sid=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeSec)}`
  ];
  const secure = process.env.QUIZ_SECURE_COOKIE === "1"
    || process.env.QUIZ_TRUST_PROXY === "1";   // 位于可信反代后通常已是 HTTPS
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * 进度合并模块与前端**同一份文件**，保证双端合并规则完全一致。
 * 这是修复「多设备覆盖丢数据」的关键：服务端不再盲目覆盖，
 * 而是把客户端提交的进度与服务端已有进度做单调合并。
 */
const QuizMerge = require(path.join(__dirname, "..", "js", "merge.js"));

const ROOT = path.join(__dirname, "..");           // quiz-system 根目录

/** 解析命令行参数 */
const ARGS = (() => {
  const a = process.argv.slice(2);
  const get = (flag) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] && !a[i + 1].startsWith("--") ? a[i + 1] : null;
  };
  const portArg = get("--port");
  return {
    port: portArg ? Number(portArg) : (Number(process.env.PORT) || 3000),
    noOpen: a.includes("--no-open") || process.env.QUIZ_NO_OPEN === "1",
    quiet: a.includes("--quiet")
  };
})();

const PORT = ARGS.port;

/** 端口被占用时自动顺延的最大尝试次数 */
const PORT_TRIES = 10;

/* ============================================================
   一、题库播种
   ============================================================ */
/** 从 js/questions.js 读取内置题库（浏览器脚本，用 vm 提供 window 环境） */
function loadBuiltinBank() {
  const code = fs.readFileSync(path.join(ROOT, "js", "questions.js"), "utf8");
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: "questions.js" });
  return sandbox.window.QUESTION_BANK || [];
}

/** 服务端题库为空时用内置题库播种；已存在则不动，避免覆盖管理员的增删改 */
function seedQuestions(force = false) {
  const table = db.questions.read();
  if (!force && table.questions.length) return { seeded: false, count: table.questions.length };

  const bank = loadBuiltinBank();
  db.questions.update((d) => {
    d.questions = bank;
    d.seededAt = Date.now();
    d.version = (d.version || 0) + 1;
  });
  return { seeded: true, count: bank.length };
}

/* ============================================================
   二、工具
   ============================================================ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

/**
 * 发送 JSON 响应。
 * 大响应会按客户端 Accept-Encoding 压缩（实测 /api/questions 可省 69%）。
 * 小响应不压缩 —— 压缩开销大于收益，且可能反而变大。
 *
 * 请求对象取自 Node 内置的 res.req，因此无需修改每个调用点。
 */
function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  };

  const req = res.req;
  let out = body;
  if (req && body.length >= Compress.MIN_COMPRESS_BYTES) {
    const enc = Compress.pickEncoding(req.headers["accept-encoding"]);
    if (enc) {
      try {
        const packed = Compress.compress(body, enc);
        // 只有确实变小才采用压缩结果
        if (packed.length < body.length) {
          out = packed;
          headers["content-encoding"] = enc;
          headers["vary"] = "Accept-Encoding";
        }
      } catch { /* 压缩失败则回退明文 */ }
    }
  }

  headers["content-length"] = out.length;
  res.writeHead(status, headers);
  res.end(out);
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 超限处理（重要，两次踩坑后定型）：
 *
 * 第一版：超限时直接 `req.destroy()` —— 客户端收到 ECONNRESET，
 *   只看到"同步失败"，无从知道是内容过大。
 *
 * 第二版：超限时 `req.pause()` 并立刻回 413 —— 仍会 ECONNRESET。
 *   原因：客户端还在上传，我们停止读取后 TCP 接收缓冲区被填满，
 *   客户端写失败先于它读到我们的响应。
 *
 * 现版本：超限后**继续消费并丢弃**剩余数据，让客户端把请求写完，
 *   待 'end' 后再回 413。这样客户端能正常读到错误信息。
 *   为防止恶意客户端无限上传，另设一个硬上限（4×），
 *   超过硬上限才强制断开 —— 那种情况下客户端本就不值得被善待。
 *
 * 上限 2 MB：实测重度用户（2000 条 × 200 字笔记）约 558 KB，
 * 原先 512 KB 会导致正常同步失败。
 */
const BODY_LIMIT = Number(process.env.QUIZ_BODY_LIMIT) || 2 * 1024 * 1024;

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    const hardLimit = limit * 4;

    const tooLargeError = () => {
      const err = new Error(`请求体过大（上限 ${Math.round(limit / 1024)} KB）`);
      err.code = "BODY_TOO_LARGE";
      err.status = 413;
      return err;
    };

    req.on("data", (c) => {
      size += c.length;

      if (!tooLarge && size > limit) {
        tooLarge = true;
        chunks.length = 0;          // 释放已缓存的数据
        // 注意：不 pause、不 destroy，继续消费以便客户端写完并读到 413
      }

      if (tooLarge) {
        // 超过硬上限：恶意或异常的大流量，直接断开
        if (size > hardLimit) {
          req.destroy();
          reject(tooLargeError());
        }
        return;                     // 丢弃数据
      }

      chunks.push(c);
    });

    req.on("end", () => {
      if (tooLarge) return reject(tooLargeError());
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("请求体不是合法 JSON")); }
    });

    req.on("error", (e) => {
      // 若已判定超限，向上抛出更明确的 413 而非底层错误
      reject(tooLarge ? tooLargeError() : e);
    });
  });
}

/** 从 Cookie 或 Authorization 头取 token */
function tokenOf(req) {
  const h = req.headers["authorization"];
  if (h && h.startsWith("Bearer ")) return h.slice(7).trim();
  const cookie = req.headers["cookie"] || "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 空进度结构（与前端合并模块保持一致） */
const emptyProgress = () => QuizMerge.emptyProgress();

/** 清洗客户端提交的进度字段，只保留白名单结构 */
function sanitizeProgress(incoming) {
  return {
    records: incoming.records && typeof incoming.records === "object" ? incoming.records : {},
    wrong: incoming.wrong && typeof incoming.wrong === "object" ? incoming.wrong : {},
    favorites: incoming.favorites && typeof incoming.favorites === "object" ? incoming.favorites : {},
    exams: Array.isArray(incoming.exams) ? incoming.exams.slice(0, QuizMerge.MAX_EXAMS) : [],
    daily: incoming.daily && typeof incoming.daily === "object" ? incoming.daily : {},
    streak: incoming.streak && typeof incoming.streak === "object"
      ? incoming.streak : { days: 0, lastDate: "" },
    review: incoming.review && typeof incoming.review === "object" ? incoming.review : {},
    notes: sanitizeNotes(incoming.notes),
    goals: sanitizeGoals(incoming.goals)
  };
}

/**
 * 清洗笔记：只保留 {text, updatedAt, createdAt}，并限制文本长度。
 * 笔记是用户自由文本，必须限长以防异常数据撑爆存储。
 */
function sanitizeNotes(raw) {
  const src = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const out = {};
  let n = 0;
  for (const [qid, v] of Object.entries(src)) {
    if (n >= 5000) break;                       // 笔记条目上限
    if (!v || typeof v !== "object") continue;
    const text = typeof v.text === "string" ? v.text.slice(0, QuizMerge.MAX_NOTE_LEN) : "";
    out[String(qid).slice(0, 64)] = {
      text,
      updatedAt: Number(v.updatedAt) || 0,
      createdAt: Number(v.createdAt) || 0
    };
    n++;
  }
  return out;
}

/** 清洗每日目标：限定数值范围 */
function sanitizeGoals(raw) {
  const g = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  return {
    dailyQuestions: clamp(g.dailyQuestions, 0, 500),
    dailyMinutes: clamp(g.dailyMinutes, 0, 600),
    updatedAt: Number(g.updatedAt) || 0
  };
}

/* ============================================================
   三、API 路由
   ============================================================ */
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

/* ---------- 认证 ---------- */

route("POST", "/api/register", async (req, res) => {
  // 注册是账号创建入口，必须限流，否则可被脚本批量刷账号
  if (RateLimit.enforce(req, res, "register", sendJson)) return;

  const { username, password, nickname } = await readBody(req);
  const r = await auth.register(username, password, nickname);
  if (!r.ok) return sendJson(res, 400, { ok: false, error: r.error });

  const token = await auth.createSession(r.user.id);
  res.setHeader("set-cookie", sessionCookie(token, auth.SESSION_TTL_MS / 1000));
  sendJson(res, 200, { ok: true, user: auth.publicUser(r.user), token });
});

route("POST", "/api/login", async (req, res) => {
  if (RateLimit.enforce(req, res, "login", sendJson)) return;

  const { username, password } = await readBody(req);
  const r = await auth.login(username, password);
  if (!r.ok) return sendJson(res, 401, { ok: false, error: r.error });

  res.setHeader("set-cookie", sessionCookie(r.token, auth.SESSION_TTL_MS / 1000));
  sendJson(res, 200, { ok: true, user: auth.publicUser(r.user), token: r.token });
});

route("POST", "/api/logout", async (req, res) => {
  await auth.destroySession(tokenOf(req));
  res.setHeader("set-cookie", sessionCookie("", 0));
  sendJson(res, 200, { ok: true });
});

route("GET", "/api/me", async (req, res) => {
  const user = auth.userFromToken(tokenOf(req));
  if (!user) return sendJson(res, 401, { ok: false, error: "未登录" });
  sendJson(res, 200, { ok: true, user: auth.publicUser(user) });
});

/* ---------- 题库 ---------- */

route("GET", "/api/questions", async (req, res, url) => {
  const all = db.questions.read().questions;
  const p = url.searchParams;

  const subject = p.get("subject");
  const chapter = p.get("chapter");
  const type = p.get("type");
  const difficulty = p.get("difficulty");
  const keyword = (p.get("q") || "").trim().toLowerCase();
  const limit = Number(p.get("limit")) || 0;
  const offset = Number(p.get("offset")) || 0;

  let list = all.filter(q =>
    (!subject || subject === "all" || q.subject === subject) &&
    (!chapter || chapter === "all" || q.chapter === chapter) &&
    (!type || type === "all" || q.type === type) &&
    (!difficulty || difficulty === "all" || String(q.difficulty) === String(difficulty)) &&
    (!keyword || q.stem.toLowerCase().includes(keyword))
  );

  const total = list.length;
  if (offset > 0) list = list.slice(offset);
  if (limit > 0) list = list.slice(0, limit);

  sendJson(res, 200, {
    ok: true, total, count: list.length,
    version: db.questions.read().version,
    questions: list
  });
});

/** 题库元信息：学科、章节、题型、难度分布，供前端渲染筛选器 */
route("GET", "/api/meta", async (req, res) => {
  const all = db.questions.read().questions;
  const subjects = {};
  for (const q of all) {
    if (!subjects[q.subject]) subjects[q.subject] = { total: 0, chapters: {} };
    subjects[q.subject].total += 1;
    subjects[q.subject].chapters[q.chapter] = (subjects[q.subject].chapters[q.chapter] || 0) + 1;
  }
  const byType = {}, byDifficulty = {};
  for (const q of all) {
    byType[q.type] = (byType[q.type] || 0) + 1;
    byDifficulty[q.difficulty] = (byDifficulty[q.difficulty] || 0) + 1;
  }
  sendJson(res, 200, {
    ok: true,
    total: all.length,
    subjectCount: Object.keys(subjects).length,
    chapterCount: new Set(all.map(q => q.subject + "/" + q.chapter)).size,
    subjects, byType, byDifficulty
  });
});

/** 按 id 取单题 */
route("GET", "/api/questions/:id", async (req, res, _url, params) => {
  const q = db.questions.read().questions.find(x => x.id === params.id);
  if (!q) return sendJson(res, 404, { ok: false, error: "题目不存在" });
  sendJson(res, 200, { ok: true, question: q });
});

/* ---------- 学习进度（需登录） ---------- */

function requireUser(req, res) {
  const user = auth.userFromToken(tokenOf(req));
  if (!user) { sendJson(res, 401, { ok: false, error: "请先登录" }); return null; }
  return user;
}

route("GET", "/api/progress", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const p = db.progress.read().progress[user.id] || emptyProgress();
  sendJson(res, 200, { ok: true, progress: p });
});

/**
 * 保存进度。**关键：这里是合并，不是覆盖。**
 *
 * 早期版本直接覆盖，导致多设备场景下「后写覆盖前写」丢数据：
 * 设备 A 答题后 PUT，设备 B 基于旧快照 PUT，A 的记录被整个抹掉。
 *
 * 现在改为把客户端进度与服务端已有进度做单调合并（计数取较大值、集合取并集），
 * 因此无论哪台设备、以什么顺序提交，结果都一致且不会丢失任何一端的记录。
 * 合并函数与前端共用同一份代码，避免双端规则漂移。
 *
 * @param ?mode=replace 显式要求覆盖（仅用于「清空进度」等场景）
 */
route("PUT", "/api/progress", async (req, res, url) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (RateLimit.enforce(req, res, "write", sendJson)) return;

  const body = await readBody(req);
  const incoming = body.progress;
  if (!incoming || typeof incoming !== "object") {
    return sendJson(res, 400, { ok: false, error: "progress 字段缺失" });
  }

  const clean = sanitizeProgress(incoming);
  const replace = url && url.searchParams.get("mode") === "replace";

  let result;
  await db.progress.update((d) => {
    const existing = d.progress[user.id] || emptyProgress();
    // replace 模式也要裁剪，避免绕过增长限制
    result = replace ? QuizMerge.pruneProgress(clean) : QuizMerge.mergeProgress(existing, clean);
    result.updatedAt = Date.now();
    d.progress[user.id] = result;
  });

  sendJson(res, 200, { ok: true, updatedAt: result.updatedAt, merged: !replace });
});

/** 合并式增量上报：单次答题结果（推荐路径，天然无并发覆盖问题） */
route("POST", "/api/progress/answer", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  if (RateLimit.enforce(req, res, "write", sendJson)) return;

  const { questionId, correct } = await readBody(req);
  if (typeof questionId !== "string" || typeof correct !== "boolean") {
    return sendJson(res, 400, { ok: false, error: "参数不正确" });
  }

  const now = Date.now();
  const dayKey = QuizMerge.dayKey(now);

  let outRecord;
  await db.progress.update((d) => {
    const p = d.progress[user.id] || emptyProgress();

    const r = p.records[questionId] || { attempts: 0, correct: 0, wrong: 0, lastResult: null, lastAt: 0 };
    r.attempts += 1;
    if (correct) { r.correct += 1; r.lastResult = "correct"; }
    else { r.wrong += 1; r.lastResult = "wrong"; }
    r.lastAt = now;
    p.records[questionId] = r;

    const day = p.daily[dayKey] || { answered: 0, correct: 0 };
    day.answered += 1;
    if (correct) day.correct += 1;
    p.daily[dayKey] = day;

    if (p.streak.lastDate !== dayKey) {
      const y = new Date(now); y.setDate(y.getDate() - 1);
      const yk = QuizMerge.dayKey(y.getTime());
      p.streak.days = p.streak.lastDate === yk ? (p.streak.days || 0) + 1 : 1;
      p.streak.lastDate = dayKey;
    }

    if (!correct) {
      const w = p.wrong[questionId] || { addedAt: now, count: 0, cleared: false };
      w.count += 1; w.cleared = false; w.addedAt = now;
      p.wrong[questionId] = w;
    } else if (p.wrong[questionId]) {
      p.wrong[questionId].cleared = true;
    }

    // 推进间隔重复调度
    p.review = p.review || {};
    p.review[questionId] = QuizMerge.scheduleReview(p.review[questionId], correct, now);

    /*
     * 仅在确实超限时才裁剪。
     * 这是答题热路径，每次都对 daily/notes 做排序不划算；
     * 先用廉价的长度检查判断，超限才付出排序成本。
     */
    const needPrune = Object.keys(p.daily).length > QuizMerge.DAILY_KEEP_DAYS
      || Object.keys(p.notes).length > QuizMerge.MAX_NOTES;

    if (needPrune) {
      const pruned = QuizMerge.pruneProgress(p, now);
      pruned.updatedAt = now;
      d.progress[user.id] = pruned;
    } else {
      p.updatedAt = now;
      d.progress[user.id] = p;
    }
    outRecord = r;
  });

  sendJson(res, 200, { ok: true, record: outRecord });
});

/** 清空该用户进度 */
route("DELETE", "/api/progress", async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  await db.progress.update((d) => { d.progress[user.id] = emptyProgress(); });
  sendJson(res, 200, { ok: true });
});

/* ---------- 管理员：题库维护 ---------- */

/** 重新播种题库（清空并覆盖为内置题库） */
route("POST", "/api/admin/reseed", async (req, res) => {
  const body = await readBody(req);
  const token = process.env.ADMIN_TOKEN;
  if (!token) return sendJson(res, 403, { ok: false, error: "未配置 ADMIN_TOKEN，已禁用该接口" });
  if (body.token !== token) return sendJson(res, 403, { ok: false, error: "管理员口令错误" });

  const r = seedQuestions(true);
  sendJson(res, 200, { ok: true, ...r });
});

/* ============================================================
   四、路由匹配
   ============================================================ */
function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const rp = r.pattern.split("/");
    const ap = pathname.split("/");
    if (rp.length !== ap.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(":")) params[rp[i].slice(1)] = decodeURIComponent(ap[i]);
      else if (rp[i] !== ap[i]) { ok = false; break; }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

/* ============================================================
   五、静态文件
   ============================================================ */

/**
 * 静态资源压缩结果的内存缓存。
 *
 * 为什么需要：katex.min.js 有 276 KB，若每次请求都重新压缩，
 * 既浪费 CPU 又阻塞事件循环。按 ETag 缓存后，同一版本只压缩一次。
 * 文件更新时 mtime 变化 → ETag 变化 → 自动重建缓存项。
 *
 * 容量上限防止长期运行下无界增长。
 */
const staticCache = new Map();
const STATIC_CACHE_MAX = 32;

/** 异步压缩，避免阻塞事件循环 */
function compressAsync(buf, encoding) {
  return new Promise((resolve, reject) => {
    const cb = (err, out) => err ? reject(err) : resolve(out);
    if (encoding === "br") {
      zlib.brotliCompress(buf, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
          [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length
        }
      }, cb);
    } else if (encoding === "gzip") {
      zlib.gzip(buf, { level: 6 }, cb);
    } else {
      zlib.deflate(buf, { level: 6 }, cb);
    }
  });
}

/**
 * 取（或构建）静态资源的缓存项。
 * @returns {Promise<{etag:string, raw:Buffer, variants:object}>}
 */
async function getStaticEntry(filePath, stat) {
  const etag = Compress.etagFor(stat);
  const cached = staticCache.get(filePath);

  // 命中且版本一致：直接复用
  if (cached && cached.etag === etag) return cached;

  const raw = await fs.promises.readFile(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const type = MIME[ext] || "application/octet-stream";
  const entry = { etag, raw, type, variants: {} };

  // 只对文本类且足够大的资源预压缩
  if (Compress.isCompressible(type) && raw.length >= Compress.MIN_COMPRESS_BYTES) {
    try {
      const [br, gzip] = await Promise.all([
        compressAsync(raw, "br"),
        compressAsync(raw, "gzip")
      ]);
      // 只在确实变小时才保留
      if (br.length < raw.length) entry.variants.br = br;
      if (gzip.length < raw.length) entry.variants.gzip = gzip;
    } catch { /* 压缩失败则只提供明文 */ }
  }

  // 简单的 LRU：超限时淘汰最早插入的项
  if (staticCache.size >= STATIC_CACHE_MAX) {
    staticCache.delete(staticCache.keys().next().value);
  }
  staticCache.set(filePath, entry);
  return entry;
}

function serveStatic(req, res, pathname) {
  // 只允许访问 ROOT 内的文件，且禁止访问 server/ 与 data/
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";

  const normalized = path.normalize(rel).replace(/^(\.\.[\/\\])+/, "");
  const filePath = path.join(ROOT, normalized);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  const relToRoot = path.relative(ROOT, filePath).split(path.sep);
  if (relToRoot[0] === "server" || relToRoot[0] === "data") {
    res.writeHead(403); return res.end("Forbidden");
  }

  fs.stat(filePath, async (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }

    const ext = path.extname(filePath).toLowerCase();

    /*
     * 缓存策略（重要，踩过坑）：
     *
     * HTML 与 JS 都用 no-cache，即「每次都必须向服务端校验」。
     * 校验命中 ETag 时返回 304，几乎不耗流量（实测 0 字节），
     * 但能保证用户拿到的永远是当前版本。
     *
     * 为什么不用 max-age：早期 JS 用了 max-age=60，浏览器在 60 秒内
     * **完全不发请求**，直接用本地缓存。若用户在这期间刷新，
     * 就会出现「新 HTML + 旧 JS」的版本错配，导致页面渲染异常
     * （表现为「没有题目」这类问题），且用户无从察觉原因。
     *
     * 字体等带内容哈希的静态资源才适合长缓存 —— 但本项目文件名不含哈希，
     * 因此统一采用 no-cache + ETag 校验，用 304 保证性能。
     */
    const cacheControl = "no-cache";

    let entry;
    try {
      entry = await getStaticEntry(filePath, st);
    } catch {
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      return res.end("500 Internal Error");
    }

    const baseHeaders = {
      "content-type": entry.type,
      "cache-control": cacheControl,
      "etag": entry.etag,
      "last-modified": st.mtime.toUTCString(),
      "vary": "Accept-Encoding"
    };

    // 协商缓存命中：返回 304，省去完整传输（原先每次都重传）
    if (Compress.isNotModified(req.headers, entry.etag, st.mtime)) {
      res.writeHead(304, baseHeaders);
      return res.end();
    }

    // 选择压缩变体
    const enc = Compress.pickEncoding(req.headers["accept-encoding"]);
    let body = entry.raw;
    const headers = { ...baseHeaders };
    if (enc && entry.variants[enc]) {
      body = entry.variants[enc];
      headers["content-encoding"] = enc;
    }
    headers["content-length"] = body.length;

    res.writeHead(200, headers);
    // HEAD 请求只返回头部
    if (req.method === "HEAD") return res.end();
    res.end(body);
  });
}

/* ============================================================
   六、请求入口
   ============================================================ */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  try {
    if (pathname.startsWith("/api/")) {
      const m = matchRoute(req.method, pathname);
      if (!m) return sendJson(res, 404, { ok: false, error: "接口不存在" });
      await m.handler(req, res, url, m.params);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      return sendJson(res, 405, { ok: false, error: "不支持的方法" });
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    const msg = e && e.message ? e.message : "服务器内部错误";
    // 请求体过大返回 413，让客户端能给出明确提示（而非 ECONNRESET）
    const status = e && e.status ? e.status
      : (e && e.code === "BODY_TOO_LARGE" ? 413 : 400);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: msg });
    else res.end();
  }
});

/* ============================================================
   七、启动
   ============================================================ */

/**
 * 模块加载时即完成数据目录准备与题库播种，
 * 这样无论通过 start() 启动还是被测试直接 require + listen，
 * 题库都保证可用。
 */
db.ensureDir();
const initialSeed = seedQuestions(false);

/**
 * 打开系统默认浏览器。
 * 用 spawn 而非 exec，避免 shell 解析 URL 中的特殊字符；
 * detached + unref 让浏览器进程独立于本服务，服务退出不影响它。
 * @returns {boolean} 是否成功发起打开动作
 */
function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;

  if (platform === "win32") {
    // Windows：用 start 打开默认浏览器（第一个空参数是窗口标题占位）
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => { /* 打不开就静默跳过，用户可手动访问 */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动成功的横幅。
 * 注意：中文是双宽字符，用 padEnd 对齐会错位，
 * 因此这里改用简单分隔线而非方框。
 */
function printBanner(port, seeded) {
  const url = `http://localhost:${port}`;
  const line = "─".repeat(52);
  console.log("");
  console.log("  ┌" + line + "┐");
  console.log("    学而刷题 · 服务已启动");
  console.log("  " + line);
  console.log(`    网址   ${url}`);
  console.log(`    题库   ${seeded.seeded ? "已播种 " : "已加载 "}${seeded.count} 道题`);
  console.log("    提示   浏览器会自动打开；若没有，请手动访问上面的网址");
  console.log("    停止   关闭本窗口，或按 Ctrl + C");
  console.log("  └" + line + "┘");
  console.log("");
}

/* ============================================================
   定期维护
   ============================================================ */

/** 维护间隔：30 分钟 */
const MAINTENANCE_INTERVAL_MS = 30 * 60 * 1000;
let maintenanceTimer = null;

/**
 * 执行一次维护：清理过期会话。
 *
 * 为什么需要定时清理：createSession 只清理「登录那一刻」的过期会话。
 * 用户登录后若再不登录，其会话会永久滞留（实测 30 次登录留下 39 条记录）。
 * 定时清理让文件大小与实际活跃会话数保持相关，而非单调增长。
 */
async function runMaintenance() {
  try {
    const removed = await auth.pruneSessions();
    if (removed > 0 && !ARGS.quiet) {
      console.log(`  [维护] 清理过期会话 ${removed} 条，剩余 ${auth.sessionCount()} 条`);
    }
  } catch (e) {
    console.warn("  [维护] 会话清理失败：", e.message);
  }
}

function startMaintenance() {
  if (maintenanceTimer) return;
  // unref 让定时器不阻止进程退出
  maintenanceTimer = setInterval(runMaintenance, MAINTENANCE_INTERVAL_MS);
  if (maintenanceTimer.unref) maintenanceTimer.unref();
}

function stopMaintenance() {
  if (maintenanceTimer) { clearInterval(maintenanceTimer); maintenanceTimer = null; }
}

/**
 * 启动服务；端口被占用时自动顺延到下一个可用端口。
 * @param {number} port 起始端口
 * @param {number} tries 剩余尝试次数
 */
function start(port = PORT, tries = PORT_TRIES) {
  const onError = (err) => {
    if (err.code === "EADDRINUSE" && tries > 0) {
      const next = port + 1;
      if (!ARGS.quiet) console.log(`  端口 ${port} 被占用，改用 ${next}…`);
      server.removeListener("error", onError);
      start(next, tries - 1);
      return;
    }
    console.error("");
    console.error("  启动失败：" + err.message);
    if (err.code === "EADDRINUSE") {
      console.error(`  端口 ${PORT}–${PORT + PORT_TRIES} 都被占用，请用 --port 指定其他端口。`);
    }
    console.error("");
    process.exitCode = 1;
  };

  server.once("error", onError);

  server.listen(port, () => {
    server.removeListener("error", onError);
    const actual = server.address().port;
    printBanner(actual, initialSeed);
    startMaintenance();

    if (!ARGS.noOpen) {
      // 稍等片刻再打开浏览器，确保监听已完全就绪
      setTimeout(() => openBrowser(`http://localhost:${actual}`), 300);
    }
  });
}

/* 进程退出时停掉定时器，避免测试环境下挂起 */
process.on("exit", stopMaintenance);

if (require.main === module) start();

module.exports = {
  server, start, seedQuestions, loadBuiltinBank, openBrowser, ARGS,
  runMaintenance, startMaintenance, stopMaintenance, BODY_LIMIT
};
