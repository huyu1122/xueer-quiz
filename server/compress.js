"use strict";
/**
 * 学而刷题 —— 响应压缩与缓存工具
 *
 * 优化目标（实测基线）：
 *   - /api/questions  36.7 KB → gzip 11.4 KB（省 69%）
 *   - 首屏关键资源    502 KB  → gzip 135 KB（省 73%）
 *   - 静态资源原先无 ETag，每次刷新都完整重传
 *
 * 设计要点：
 *   - 只压缩「值得压缩」的类型（文本类），图片/字体已压缩过，再压无收益且耗 CPU
 *   - 低于阈值的内容不压缩（小响应压缩后可能更大，且白费 CPU）
 *   - 用 Brotli 优先、gzip 兜底，按客户端 Accept-Encoding 协商
 *   - ETag 用「大小 + mtime」生成，避免每次读取文件内容算哈希
 */
const zlib = require("zlib");

/** 值得压缩的 MIME 类型前缀 */
const COMPRESSIBLE = [
  "text/",
  "application/json",
  "application/javascript",
  "application/xml",
  "image/svg+xml"
];

/** 低于该字节数不压缩：压缩开销大于收益 */
const MIN_COMPRESS_BYTES = 1024;

/** Brotli 质量。4 在压缩率与 CPU 之间较均衡（默认 11 太慢） */
const BROTLI_QUALITY = 4;
/** gzip 级别。6 是 zlib 默认的均衡值 */
const GZIP_LEVEL = 6;

/** 该 MIME 是否值得压缩 */
function isCompressible(contentType) {
  if (!contentType) return false;
  const ct = String(contentType).toLowerCase();
  return COMPRESSIBLE.some(prefix => ct.startsWith(prefix));
}

/**
 * 解析 Accept-Encoding，选择最合适的编码。
 * @param {string} header
 * @returns {"br"|"gzip"|"deflate"|null}
 */
function pickEncoding(header) {
  if (!header) return null;
  const h = String(header).toLowerCase();

  // q=0 表示显式拒绝该编码
  const accepts = (name) => {
    const re = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q\\s*=\\s*([0-9.]+))?`);
    const m = h.match(re);
    if (!m) return false;
    if (m[1] !== undefined) return parseFloat(m[1]) > 0;
    return true;
  };

  // 优先 Brotli（压缩率最高），其次 gzip，最后 deflate
  if (accepts("br")) return "br";
  if (accepts("gzip")) return "gzip";
  if (accepts("deflate")) return "deflate";
  return null;
}

/**
 * 压缩 Buffer。
 * @param {Buffer} buf
 * @param {"br"|"gzip"|"deflate"} encoding
 * @returns {Buffer}
 */
function compress(buf, encoding) {
  if (encoding === "br") {
    return zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length
      }
    });
  }
  if (encoding === "gzip") return zlib.gzipSync(buf, { level: GZIP_LEVEL });
  return zlib.deflateSync(buf, { level: GZIP_LEVEL });
}

/**
 * 生成 ETag。用 size + mtimeMs 组合，避免读文件内容算哈希。
 * 文件内容变化时 mtime 会变，因此足以作为缓存校验依据。
 * @param {import("fs").Stats} stat
 * @returns {string} 形如 "1a2b-3c4d"
 */
function etagFor(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * 判断请求是否命中协商缓存。
 * 同时支持 If-None-Match（ETag）与 If-Modified-Since。
 * @param {object} headers 请求头
 * @param {string} etag
 * @param {Date} mtime
 * @returns {boolean} 命中则调用方应返回 304
 */
function isNotModified(headers, etag, mtime) {
  const inm = headers["if-none-match"];
  if (inm) {
    // 可能是逗号分隔的列表，或 W/ 弱校验前缀
    const tags = String(inm).split(",").map(s => s.trim().replace(/^W\//, ""));
    if (tags.includes(etag) || tags.includes("*")) return true;
  }
  const ims = headers["if-modified-since"];
  if (ims) {
    const since = Date.parse(ims);
    if (!isNaN(since) && mtime && Math.floor(mtime.getTime() / 1000) * 1000 <= since) return true;
  }
  return false;
}

module.exports = {
  isCompressible, pickEncoding, compress, etagFor, isNotModified,
  MIN_COMPRESS_BYTES
};
