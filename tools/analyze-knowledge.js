/**
 * 知识点分布分析（临时脚本）
 * 目的：检查标签是否过度碎片化，影响热力图可用性
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FILE = path.join(__dirname, "..", "js", "questions.js");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox);
const BANK = sandbox.window.QUESTION_BANK;

const count = {};
BANK.forEach(q => (q.knowledge || []).forEach(t => { count[t] = (count[t] || 0) + 1; }));

const entries = Object.entries(count).sort((a, b) => b[1] - a[1]);
console.log(`知识点总数：${entries.length}，题目总数：${BANK.length}`);
console.log(`平均每题标签数：${(BANK.reduce((s, q) => s + q.knowledge.length, 0) / BANK.length).toFixed(2)}`);

const once = entries.filter(([, n]) => n === 1);
const few = entries.filter(([, n]) => n <= 2);
console.log(`\n只出现 1 次的知识点：${once.length} 个（占 ${(once.length / entries.length * 100).toFixed(0)}%）`);
console.log(`出现 ≤2 次的知识点：${few.length} 个（占 ${(few.length / entries.length * 100).toFixed(0)}%）`);

console.log("\n出现次数 ≥3 的知识点（可用于热力图）：");
entries.filter(([, n]) => n >= 3).forEach(([t, n]) => console.log(`  ${String(n).padStart(2)}  ${t}`));

console.log("\n只出现 1 次的知识点（碎片，建议合并）：");
once.forEach(([t]) => console.log(`   ${t}`));
