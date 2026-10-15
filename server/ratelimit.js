"use strict";
/**
 * 学而刷题 —— 简单令牌桶限流
 *
 * 背景（实测）：登录有防爆破（5 次失败锁 10 分钟），但**注册接口无任何限制**，
 * 20 个并发注册全部成功，可被脚本批量刷账号。
 *
 * 设计取舍：
 *   - 内存实现，单进程有效。多实例部署需换 Redis，但本项目定位是单进程自用/班级。
 *   - 按 IP 计数。反向代理后需读 X-Forwarded-For（由 TRUST_PROXY 控制，
 *     默认关闭 —— 否则客户端可伪造该头绕过限流）。
 *   - 定期清理过期桶，避免 Map 无限增长。
 */

/**
 * 各接口的限流配置：窗口毫秒数 / 窗口内最大请求数。
 *
 * 可通过环境变量覆盖，便于按实际规模调整：
 *   QUIZ_RL_REGISTER=20  每 IP 每小时可注册的账号数
 *   QUIZ_RL_LOGIN=30     每 IP 每 15 分钟可尝试登录次数
 *   QUIZ_RL_WRITE=120    每分钟进度写入次数
 *
 * 默认值取舍：注册 10/小时 对「一个班共用同一出口 IP」偏紧，
 * 若确实存在 NAT 共享场景，可用 QUIZ_RL_REGISTER 调高。
 */
const envInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const LIMITS = {
  register: { windowMs: 60 * 60 * 1000, max: envInt("QUIZ_RL_REGISTER", 10) },
  login: { windowMs: 15 * 60 * 1000, max: envInt("QUIZ_RL_LOGIN", 30) },
  write: { windowMs: 60 * 1000, max: envInt("QUIZ_RL_WRITE", 120) }
};

/** 是否信任 X-Forwarded-For（仅在确实位于可信反代之后时才应开启） */
const TRUST_PROXY = process.env.QUIZ_TRUST_PROXY === "1";

/**
 * 是否禁用限流。
 * 测试与压测需要大量注册，若被限流会得到假失败；
 * 生产环境不应设置此变量。
 */
const DISABLED = process.env.QUIZ_DISABLE_RATELIMIT === "1";

/** { [key]: { count, resetAt } } */
const buckets = new Map();

/** 上次清理时间，用于节流清理动作本身 */
let lastSweep = 0;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** 取客户端标识。默认用 socket 地址，避免伪造头绕过限流 */
function clientKey(req) {
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (xff) {
      // 取最左侧（最接近客户端）的地址
      const first = String(xff).split(",")[0].trim();
      if (first) return first;
    }
  }
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/** 清理过期桶 */
function sweep(now) {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [k, b] of buckets) {
    if (b.resetAt <= now) buckets.delete(k);
  }
}

/**
 * 检查是否允许该请求。
 * @param {object} req
 * @param {keyof LIMITS} kind
 * @returns {{allowed:boolean, retryAfterSec?:number, remaining?:number}}
 */
function check(req, kind) {
  if (DISABLED) return { allowed: true };
  const cfg = LIMITS[kind];
  if (!cfg) return { allowed: true };

  const now = Date.now();
  sweep(now);

  const key = kind + ":" + clientKey(req);
  let b = buckets.get(key);

  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + cfg.windowMs };
    buckets.set(key, b);
  }

  b.count += 1;

  if (b.count > cfg.max) {
    return {
      allowed: false,
      retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
      remaining: 0
    };
  }
  return { allowed: true, remaining: cfg.max - b.count };
}

/**
 * 限流中间件式辅助：不允许时直接写 429 响应。
 * @returns {boolean} true 表示已响应（调用方应 return）
 */
function enforce(req, res, kind, sendJson) {
  const r = check(req, kind);
  if (r.allowed) return false;
  sendJson(res, 429, {
    ok: false,
    error: `请求过于频繁，请 ${r.retryAfterSec} 秒后再试`
  });
  return true;
}

/** 当前桶数量（诊断用） */
function size() { return buckets.size; }

/** 重置（测试用） */
function reset() { buckets.clear(); lastSweep = 0; }

module.exports = { LIMITS, check, enforce, size, reset, clientKey };
