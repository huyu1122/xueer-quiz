"use strict";
/**
 * 学而刷题 —— 服务端数据层
 * 零依赖的 JSON 文件存储：内存缓存 + 原子写入（临时文件 + rename）。
 * 单进程部署，因此用「写入串行队列」避免并发写互相覆盖。
 */
const fs = require("fs");
const path = require("path");

/**
 * 数据目录。默认 server/data；
 * 可用环境变量 QUIZ_DATA_DIR 覆盖（测试用独立目录，避免污染正式数据）。
 */
const DATA_DIR = process.env.QUIZ_DATA_DIR
  ? path.resolve(process.env.QUIZ_DATA_DIR)
  : path.join(__dirname, "data");

/** 确保数据目录存在 */
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * 一个 JSON 文件集合（表）。所有读写经内存缓存，
 * 每次写入落盘为完整快照，保证进程重启后可恢复。
 */
class JsonTable {
  /**
   * @param {string} filename 数据文件名（不含路径）
   * @param {object} initial 初始结构
   */
  constructor(filename, initial) {
    ensureDir();
    this.file = path.join(DATA_DIR, filename);
    this.initial = initial;
    this._cache = null;
    this._queue = Promise.resolve();
    this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this._cache = parsed && typeof parsed === "object" ? parsed : structuredClone(this.initial);
    } catch (e) {
      if (e.code !== "ENOENT") {
        // 文件损坏时不静默丢弃：备份后重建，便于事后排查
        try {
          fs.renameSync(this.file, this.file + ".corrupt-" + Date.now());
          console.warn(`[db] ${path.basename(this.file)} 解析失败，已备份并重建：${e.message}`);
        } catch { /* 备份失败则继续，用初始结构 */ }
      }
      this._cache = structuredClone(this.initial);
    }
  }

  /** 读取缓存（返回引用，调用方勿直接改；改请用 update） */
  read() {
    return this._cache;
  }

  /** 原子写盘 */
  _persist() {
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2), "utf8");
    fs.renameSync(tmp, this.file);
  }

  /**
   * 串行化的读-改-写。回调直接修改传入对象，返回值会被忽略。
   * @param {(data:any)=>void} fn
   */
  update(fn) {
    this._queue = this._queue.then(() => {
      fn(this._cache);
      this._persist();
    }).catch((e) => {
      console.error("[db] 写入失败：", e.message);
    });
    return this._queue;
  }
}

/* ============================================================
   表定义
   ============================================================ */

/** 用户表：{ users: { [id]: {id, username, nickname, salt, hash, createdAt} }, byName: {usernameLower: id} } */
const users = new JsonTable("users.json", { users: {}, byName: {} });

/** 会话表：{ sessions: { [token]: {token, userId, createdAt, expiresAt} } } */
const sessions = new JsonTable("sessions.json", { sessions: {} });

/** 学习进度表：{ progress: { [userId]: {records, wrong, favorites, exams, daily, streak, updatedAt} } } */
const progress = new JsonTable("progress.json", { progress: {} });

/** 服务端题库表：{ questions: [...], seededAt, version } */
const questions = new JsonTable("questions.json", { questions: [], seededAt: 0, version: 1 });

/** 登录尝试记录（内存即可，重启清零）：{ [usernameLower]: {fails, lockedUntil} } */
const loginAttempts = new Map();

module.exports = { users, sessions, progress, questions, loginAttempts, DATA_DIR, ensureDir };
