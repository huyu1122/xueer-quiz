/**
 * 学而刷题 —— API 客户端
 * 负责与 Node 服务端通信；服务端不可用时自动降级为本地模式。
 */
const Api = (() => {
  const TOKEN_KEY = "xueer-token";
  let token = null;
  try { token = localStorage.getItem(TOKEN_KEY); } catch { /* 隐私模式 */ }

  /** 服务端可用性：null=未知, true/false=已探测 */
  let online = null;

  function setToken(t) {
    token = t || null;
    try {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    } catch { /* 忽略 */ }
  }

  function getToken() { return token; }

  async function request(method, url, body, opts = {}) {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["authorization"] = "Bearer " + token;

    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: opts.signal
    });

    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 响应 */ }

    if (!res.ok) {
      const err = new Error((data && data.error) || `请求失败（${res.status}）`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  return {
    get online() { return online; },
    getToken, setToken,

    /** 探测服务端是否可用；结果缓存 */
    async detect(force = false) {
      if (online !== null && !force) return online;
      try {
        const res = await fetch("/api/meta", { method: "GET" });
        online = res.ok;
      } catch {
        online = false;
      }
      return online;
    },

    /* ---------- 认证 ---------- */
    async register(username, password, nickname) {
      const r = await request("POST", "/api/register", { username, password, nickname });
      if (r.token) setToken(r.token);
      return r.user;
    },

    async login(username, password) {
      const r = await request("POST", "/api/login", { username, password });
      if (r.token) setToken(r.token);
      return r.user;
    },

    async logout() {
      try { await request("POST", "/api/logout"); } catch { /* 即使失败也清本地 */ }
      setToken(null);
    },

    /** 用已保存的 token 恢复会话；失败返回 null */
    async me() {
      if (!token) return null;
      try {
        const r = await request("GET", "/api/me");
        return r.user;
      } catch (e) {
        if (e.status === 401) setToken(null);
        return null;
      }
    },

    /* ---------- 题库 ---------- */
    async fetchQuestions(params = {}) {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== null && v !== "" && v !== "all") qs.set(k, v);
      });
      const suffix = qs.toString() ? "?" + qs.toString() : "";
      return request("GET", "/api/questions" + suffix);
    },

    async fetchMeta() { return request("GET", "/api/meta"); },

    /* ---------- 学习进度 ---------- */
    async fetchProgress() {
      const r = await request("GET", "/api/progress");
      return r.progress;
    },

    async saveProgress(progress) {
      return request("PUT", "/api/progress", { progress });
    },

    async reportAnswer(questionId, correct) {
      return request("POST", "/api/progress/answer", { questionId, correct });
    },

    async clearProgress() {
      return request("DELETE", "/api/progress");
    }
  };
})();

window.Api = Api;
