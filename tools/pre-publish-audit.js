/**
 * 上传前安全审计
 * 检查是否有可能泄露敏感信息的文件被提交
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

console.log("=".repeat(66));
console.log("上传前安全审计");
console.log("=".repeat(66));

/* ---------- 1. 运行时数据（最可能含用户信息） ---------- */
console.log("\n【1】运行时数据（含用户与会话，绝不能上传）");
const dataDir = path.join(ROOT, "server", "data");
if (fs.existsSync(dataDir)) {
  const files = fs.readdirSync(dataDir);
  console.log("  ⚠ server/data 存在，含以下文件：");
  files.forEach(f => {
    const st = fs.statSync(path.join(dataDir, f));
    console.log(`    ${f}  ${st.size} B`);
  });
  console.log("  → 必须加入 .gitignore，且上传前删除");
} else {
  console.log("  ✓ server/data 不存在（已被清空）");
}

/* ---------- 2. node_modules ---------- */
console.log("\n【2】依赖目录");
const nm = path.join(ROOT, "node_modules");
if (fs.existsSync(nm)) {
  let count = 0, size = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { count++; try { size += fs.statSync(p).size; } catch {} }
    }
  };
  walk(nm);
  console.log(`  node_modules 存在：${count} 个文件，${(size / 1024 / 1024).toFixed(1)} MB`);
  console.log("  → 必须忽略（应由 npm install 重建）");
} else {
  console.log("  ✓ node_modules 不存在");
}

/* ---------- 3. 扫描敏感信息模式 ---------- */
console.log("\n【3】扫描源码中的敏感信息");

const PATTERNS = [
  { name: "私钥", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: "GitHub Token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { name: "AWS Key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "通用 API Key 赋值", re: /(api[_-]?key|apikey|secret|password|passwd|pwd)\s*[:=]\s*["'][^"'\s]{12,}["']/i },
  { name: "Bearer Token", re: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/ },
  { name: "邮箱地址", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/ },
  { name: "绝对用户路径", re: /[A-Z]:\\Users\\[A-Za-z0-9_.-]+/ },
  { name: "IPv4 地址", re: /\b(?:\d{1,3}\.){3}\d{1,3}\b/ }
];

const SKIP_DIRS = new Set(["node_modules", ".git", "data", "vendor"]);
const TEXT_EXT = new Set([".js", ".json", ".md", ".html", ".css", ".cmd", ".yml", ".yaml", ".txt", ".gitignore"]);

const findings = [];
function scanFile(file) {
  const ext = path.extname(file).toLowerCase();
  const base = path.basename(file);
  if (!TEXT_EXT.has(ext) && base !== ".gitignore") return;

  let content;
  try { content = fs.readFileSync(file, "utf8"); } catch { return; }
  const lines = content.split("\n");
  const rel = path.relative(ROOT, file);

  lines.forEach((line, i) => {
    // 跳过明显的注释说明与测试用的假数据
    PATTERNS.forEach(p => {
      if (p.re.test(line)) {
        findings.push({
          file: rel,
          line: i + 1,
          kind: p.name,
          text: line.trim().slice(0, 100)
        });
      }
    });
  });
}

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name));
    } else {
      scanFile(path.join(dir, e.name));
    }
  }
}
walk(ROOT);

/* 归类：区分「真问题」与「正常内容」 */
const byKind = {};
findings.forEach(f => { (byKind[f.kind] = byKind[f.kind] || []).push(f); });

for (const [kind, list] of Object.entries(byKind)) {
  console.log(`\n  ── ${kind}（${list.length} 处）`);
  list.slice(0, 8).forEach(f => {
    console.log(`     ${f.file}:${f.line}`);
    console.log(`       ${f.text}`);
  });
  if (list.length > 8) console.log(`     ...还有 ${list.length - 8} 处`);
}

/* ---------- 4. 逐项判定 ---------- */
console.log("\n【4】判定");

const realRisks = [];
if (byKind["私钥"]) realRisks.push("发现私钥！");
if (byKind["GitHub Token"]) realRisks.push("发现 GitHub Token！");
if (byKind["AWS Key"]) realRisks.push("发现 AWS 密钥！");
if (byKind["通用 API Key 赋值"]) realRisks.push("发现疑似密钥赋值（需人工确认）");

/* 绝对路径是隐私问题（暴露用户名） */
const absPaths = byKind["绝对用户路径"] || [];
if (absPaths.length) {
  console.log(`  ⚠ 发现 ${absPaths.length} 处包含本机绝对路径（会暴露用户名 "${process.env.USERNAME}"）`);
  const files = [...new Set(absPaths.map(f => f.file))];
  console.log(`    涉及文件：${files.join(", ")}`);
  realRisks.push("绝对路径需清理");
}

/* 邮箱 */
const emails = byKind["邮箱地址"] || [];
if (emails.length) {
  const uniq = [...new Set(emails.map(f => (f.text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/) || [""])[0]))];
  console.log(`  ℹ 发现邮箱：${uniq.join(", ")}`);
  console.log("    （若是测试数据则无妨；若是你的真实邮箱，注意是否会公开）");
}

/* IP 地址 */
const ips = byKind["IPv4 地址"] || [];
if (ips.length) {
  const uniq = [...new Set(ips.map(f => (f.text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/) || [""])[0]))];
  console.log(`  ℹ 发现 IP：${uniq.join(", ")}`);
  console.log("    （127.0.0.1 / 0.0.0.0 属正常，其他需确认）");
}

console.log("\n" + "=".repeat(66));
if (realRisks.length === 0) {
  console.log("✓ 未发现必须处理的安全风险");
} else {
  console.log("需要处理：");
  realRisks.forEach(r => console.log("  - " + r));
}
console.log("=".repeat(66));
