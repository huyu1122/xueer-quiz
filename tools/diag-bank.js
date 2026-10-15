/**
 * 题库诊断工具
 *
 * 用途：当页面显示「没有题目」时，快速确认题库本身是否完好。
 * 检查内置题库与服务端题库的数量、字段完整性、以及两者是否一致。
 *
 * 运行： node tools/diag-bank.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");

console.log("=".repeat(62));
console.log("题库诊断");
console.log("=".repeat(62));

/* ---------- 1. 内置题库 ---------- */
console.log("\n【1】内置题库 js/questions.js");
let builtin = null;
try {
  const sandbox = { window: {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, "js", "questions.js"), "utf8"), sandbox);
  builtin = sandbox.window.QUESTION_BANK;

  if (!Array.isArray(builtin)) {
    console.log("  ✗ QUESTION_BANK 不是数组，实际类型:", typeof builtin);
  } else {
    console.log("  ✓ 加载成功");
    console.log("    题目数量:", builtin.length);
    const subjects = [...new Set(builtin.map(q => q.subject))];
    console.log("    学科数量:", subjects.length);
    console.log("    学科列表:", subjects.join("、"));

    const byType = {};
    builtin.forEach(q => { byType[q.type] = (byType[q.type] || 0) + 1; });
    console.log("    题型分布:", Object.entries(byType).map(([k, v]) => `${k}=${v}`).join(" "));

    const need = ["id", "subject", "chapter", "type", "difficulty", "stem", "answer", "analysis"];
    const bad = builtin.filter(q => need.some(f => q[f] === undefined));
    console.log("    字段完整的题目:", builtin.length - bad.length, "/", builtin.length);
    if (bad.length) {
      console.log("    ✗ 缺字段的题目:", bad.slice(0, 5).map(q => q.id || "(无id)").join(", "));
    }

    const badOpt = builtin.filter(q => q.type !== "fill" && (!Array.isArray(q.options) || q.options.length < 2));
    const badAns = builtin.filter(q =>
      q.type !== "fill" && (!Array.isArray(q.answer) || q.answer.some(i => i >= (q.options || []).length)));
    console.log("    选项缺失:", badOpt.length, " 答案越界:", badAns.length);

    const ids = new Set(builtin.map(q => q.id));
    console.log("    id 唯一:", ids.size === builtin.length ? "✓" : `✗ 有 ${builtin.length - ids.size} 个重复`);
  }
} catch (e) {
  console.log("  ✗ 加载失败:", e.message);
}

/* ---------- 2. 服务端题库 ---------- */
console.log("\n【2】服务端题库 server/data/questions.json");
const dataFile = path.join(ROOT, "server", "data", "questions.json");
if (!fs.existsSync(dataFile)) {
  console.log("  文件不存在");
  console.log("  → 首次启动服务时会自动播种，属正常情况");
} else {
  try {
    const raw = fs.readFileSync(dataFile, "utf8");
    const d = JSON.parse(raw);
    console.log("  文件大小:", (raw.length / 1024).toFixed(1), "KB");
    console.log("  questions 是数组:", Array.isArray(d.questions) ? "✓" : "✗");

    if (Array.isArray(d.questions)) {
      console.log("  题目数量:", d.questions.length);
      if (d.questions.length === 0) {
        console.log("  ✗ 服务端题库为空！");
        console.log("    → 可删除 server/data/questions.json 后重启服务，会重新播种");
      } else {
        console.log("  ✓ 服务端题库正常");
      }
    }
    console.log("  seededAt:", d.seededAt ? new Date(d.seededAt).toLocaleString() : "(无)");
    console.log("  version:", d.version);
  } catch (e) {
    console.log("  ✗ 解析失败:", e.message);
    console.log("    → 文件可能损坏，删除后重启服务会重新播种");
  }
}

/* ---------- 3. 一致性 ---------- */
console.log("\n【3】一致性");
if (builtin && Array.isArray(builtin)) {
  console.log("  内置题库题目数:", builtin.length);
  if (fs.existsSync(dataFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(dataFile, "utf8"));
      const n = Array.isArray(d.questions) ? d.questions.length : 0;
      if (n === builtin.length) {
        console.log("  ✓ 服务端题库与内置题库数量一致");
      } else {
        console.log(`  提示：服务端 ${n} 题，内置 ${builtin.length} 题`);
        console.log("        若你刚更新过 questions.js，需重新播种（见 README）");
      }
    } catch { /* 上面已报告 */ }
  }
}

console.log("\n" + "=".repeat(62));
console.log("若以上均正常，但页面仍无题目：");
console.log("  1. 强制刷新 Ctrl + Shift + R");
console.log("  2. F12 查看 Console 是否有红色错误");
console.log("  3. 执行 localStorage.removeItem('xueer-quiz-v1') 后刷新");
console.log("=".repeat(62));
