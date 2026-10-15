"use strict";
/**
 * 学而刷题 —— 认证模块
 * - 密码：scrypt + 随机盐，恒定时间比较，不存明文
 * - 会话：随机 32 字节 token，带过期时间，服务端可撤销
 * - 防爆破：按用户名计失败次数，超限临时锁定
 *
 * 性能说明：
 *   scrypt 单次约 25 ms。早期用 scryptSync 会**完全阻塞事件循环**，
 *   实测 8 个并发注册耗时 215 ms（近似线性叠加），期间任何请求都无法处理。
 *   现改用异步 crypto.scrypt：哈希在 libuv 线程池中执行，
 *   事件循环保持可响应，多个哈希可真正并发。
 */
const crypto = require("crypto");
const { users, sessions, loginAttempts } = require("./db");

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;   // 会话 7 天
const MAX_FAILS = 5;                               // 连续失败上限
const LOCK_MS = 10 * 60 * 1000;                    // 锁定时长 10 分钟
const SCRYPT_KEYLEN = 64;

/**
 * 异步 scrypt。返回 Promise<Buffer>。
 * 用异步版本而非 scryptSync，避免阻塞事件循环。
 */
function scryptAsync(password, salt, keylen) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/* ---------- 密码 ---------- */
/** @returns {Promise<string>} hex 编码的哈希 */
async function hashPassword(password, salt) {
  const buf = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  return buf.toString("hex");
}

/** @returns {Promise<boolean>} 恒定时间比较，避免时序侧信道 */
async function verifyPassword(password, salt, expectedHex) {
  const actual = await scryptAsync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

/** 用户不存在时执行的占位哈希，用于抹平响应时间差异 */
const DUMMY_SALT = "00000000000000000000000000000000";
async function dummyHash(password) {
  try { await scryptAsync(password, DUMMY_SALT, SCRYPT_KEYLEN); } catch { /* 忽略 */ }
}

/* ---------- 校验 ---------- */
const USERNAME_RE = /^[A-Za-z0-9_\u4e00-\u9fa5]{3,20}$/;

function validateCredentials(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return "用户名和密码不能为空";
  }
  const u = username.trim();
  if (!USERNAME_RE.test(u)) {
    return "用户名需 3–20 位，仅支持中文、字母、数字和下划线";
  }
  if (password.length < 6) return "密码至少 6 位";
  if (password.length > 128) return "密码过长";
  return null;
}

/* ---------- 登录尝试限制 ---------- */
function checkLock(usernameLower) {
  const rec = loginAttempts.get(usernameLower);
  if (!rec) return null;
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    const sec = Math.ceil((rec.lockedUntil - Date.now()) / 1000);
    return `登录失败次数过多，请 ${sec} 秒后再试`;
  }
  return null;
}

function noteFail(usernameLower) {
  const rec = loginAttempts.get(usernameLower) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.fails = 0;
  }
  loginAttempts.set(usernameLower, rec);
}

function clearFails(usernameLower) {
  loginAttempts.delete(usernameLower);
}

/* ---------- 注册 ---------- */
/**
 * @returns {{ok:true, user:object} | {ok:false, error:string}}
 */
async function register(username, password, nickname) {
  const err = validateCredentials(username, password);
  if (err) return { ok: false, error: err };

  const name = username.trim();
  const lower = name.toLowerCase();

  if (users.read().byName[lower]) {
    return { ok: false, error: "该用户名已被注册" };
  }

  const id = "u_" + crypto.randomBytes(9).toString("hex");
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);

  const user = {
    id,
    username: name,
    nickname: (nickname && String(nickname).trim().slice(0, 24)) || name,
    salt,
    hash,
    createdAt: Date.now()
  };

  await users.update((d) => {
    d.users[id] = user;
    d.byName[lower] = id;
  });

  return { ok: true, user };
}

/* ---------- 登录 ---------- */
async function login(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    return { ok: false, error: "用户名和密码不能为空" };
  }
  const lower = username.trim().toLowerCase();

  const lockMsg = checkLock(lower);
  if (lockMsg) return { ok: false, error: lockMsg };

  const d = users.read();
  const id = d.byName[lower];
  const user = id ? d.users[id] : null;

  // 用户不存在时也执行一次哈希，避免通过响应时间枚举用户名
  if (!user) {
    await dummyHash(password);
    noteFail(lower);
    return { ok: false, error: "用户名或密码错误" };
  }

  if (!(await verifyPassword(password, user.salt, user.hash))) {
    noteFail(lower);
    return { ok: false, error: "用户名或密码错误" };
  }

  clearFails(lower);
  const token = await createSession(user.id);
  return { ok: true, user, token };
}

/* ---------- 会话 ---------- */
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const now = Date.now();
  await sessions.update((d) => {
    // 顺手清理该用户的过期会话，避免文件无限增长
    for (const [t, s] of Object.entries(d.sessions)) {
      if (s.expiresAt <= now) delete d.sessions[t];
    }
    d.sessions[token] = { token, userId, createdAt: now, expiresAt: now + SESSION_TTL_MS };
  });
  return token;
}

/** 由 token 解析用户；过期则返回 null */
function userFromToken(token) {
  if (!token || typeof token !== "string") return null;
  const s = sessions.read().sessions[token];
  if (!s) return null;
  if (s.expiresAt <= Date.now()) return null;
  const user = users.read().users[s.userId];
  return user || null;
}

async function destroySession(token) {
  if (!token) return;
  await sessions.update((d) => { delete d.sessions[token]; });
}

/** 对外暴露的用户信息（去掉敏感字段） */
function publicUser(user) {
  return { id: user.id, username: user.username, nickname: user.nickname, createdAt: user.createdAt };
}

/* ---------- 会话清理 ---------- */

/**
 * 清理所有过期会话。
 *
 * 为什么需要：createSession 里只清理「登录那一刻」的过期会话。
 * 若某用户登录后再不登录，其会话会永久留在 sessions.json 中。
 * 实测 30 次登录产生 39 条会话记录，长期运行会持续膨胀。
 *
 * @returns {Promise<number>} 清理掉的条数
 */
async function pruneSessions() {
  const now = Date.now();
  let removed = 0;
  await sessions.update((d) => {
    for (const [t, s] of Object.entries(d.sessions)) {
      if (!s || !s.expiresAt || s.expiresAt <= now) { delete d.sessions[t]; removed++; }
    }
  });
  return removed;
}

/** 当前会话总数（用于诊断） */
function sessionCount() {
  return Object.keys(sessions.read().sessions).length;
}

module.exports = {
  register, login, createSession, userFromToken, destroySession,
  publicUser, validateCredentials, pruneSessions, sessionCount,
  SESSION_TTL_MS
};
