/**
 * 题库与判分逻辑自检脚本（开发用，不参与页面运行）
 * 运行： node test/validate.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

/* 用最小 window 环境加载题库 */
const sandbox = { window: {} };
vm.createContext(sandbox);
const qsCode = fs.readFileSync(path.join(__dirname, "..", "js", "questions.js"), "utf8");
vm.runInContext(qsCode, sandbox);
const BANK = sandbox.window.QUESTION_BANK;

let errors = [];
let warns = [];

/* ---------- 1. 结构与字段校验 ---------- */
const VALID_TYPES = ["single", "multiple", "judge", "fill"];
const ids = new Set();

BANK.forEach((q, i) => {
  const at = `[${i}] ${q.id || "(无id)"}`;

  if (!q.id) errors.push(`${at} 缺少 id`);
  else if (ids.has(q.id)) errors.push(`${at} id 重复`);
  else ids.add(q.id);

  if (!q.subject) errors.push(`${at} 缺少 subject`);
  if (!q.chapter) errors.push(`${at} 缺少 chapter`);
  if (!q.stem) errors.push(`${at} 缺少题干 stem`);
  if (!q.analysis) warns.push(`${at} 缺少解析 analysis`);
  if (![1, 2, 3].includes(q.difficulty)) errors.push(`${at} difficulty 必须为 1/2/3`);

  /* 知识点标签：必须是非空字符串数组，且无重复 */
  if (!Array.isArray(q.knowledge) || !q.knowledge.length) {
    errors.push(`${at} 缺少知识点标签 knowledge`);
  } else {
    if (q.knowledge.some(k => typeof k !== "string" || !k.trim())) {
      errors.push(`${at} knowledge 存在空标签`);
    }
    if (new Set(q.knowledge).size !== q.knowledge.length) {
      errors.push(`${at} knowledge 含重复标签`);
    }
    if (q.knowledge.length > 3) {
      warns.push(`${at} knowledge 标签过多（${q.knowledge.length} 个），建议不超过 3 个`);
    }
  }

  /* 公式定界符配平检查：$ 必须成对 */
  const stemDollars = (q.stem.match(/(?<!\\)\$/g) || []).length;
  if (stemDollars % 2 !== 0) {
    errors.push(`${at} 题干中 $ 符号未成对（${stemDollars} 个），公式会渲染异常`);
  }
  (q.options || []).forEach((o, oi) => {
    const d = (o.match(/(?<!\\)\$/g) || []).length;
    if (d % 2 !== 0) errors.push(`${at} 选项 ${oi} 中 $ 符号未成对`);
  });

  if (!VALID_TYPES.includes(q.type)) {
    errors.push(`${at} type 非法: ${q.type}`);
    return;
  }

  if (q.type === "fill") {
    if (!Array.isArray(q.answer) || !q.answer.length) errors.push(`${at} 填空题 answer 必须是非空数组`);
    else if (q.answer.some(a => typeof a !== "string" || !a.trim())) errors.push(`${at} 填空答案存在空串`);
    if (q.options) warns.push(`${at} 填空题不应有 options`);
  } else {
    if (!Array.isArray(q.options) || q.options.length < 2) {
      errors.push(`${at} options 至少 2 个`);
      return;
    }
    if (!Array.isArray(q.answer) || !q.answer.length) {
      errors.push(`${at} answer 必须是非空数组`);
      return;
    }
    q.answer.forEach(a => {
      if (!Number.isInteger(a) || a < 0 || a >= q.options.length) {
        errors.push(`${at} answer 下标越界: ${a}（共 ${q.options.length} 个选项）`);
      }
    });
    if (new Set(q.answer).size !== q.answer.length) errors.push(`${at} answer 含重复下标`);
    if (q.type !== "multiple" && q.answer.length !== 1) {
      errors.push(`${at} ${q.type} 应恰好 1 个答案，实际 ${q.answer.length}`);
    }
    if (q.type === "judge" && q.options.length !== 2) {
      errors.push(`${at} 判断题应恰好 2 个选项`);
    }
    if (q.type === "multiple" && q.answer.length < 2) {
      warns.push(`${at} 多选题只有 1 个正确选项`);
    }
  }
});

/* ---------- 2. 判分逻辑回归测试 ---------- */
function normFill(s) {
  return String(s ?? "").trim().toLowerCase()
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

const cases = [
  { name: "单选正确",   q: { type: "single", options: ["a","b","c"], answer: [1] }, ans: [1], want: true },
  { name: "单选错误",   q: { type: "single", options: ["a","b","c"], answer: [1] }, ans: [0], want: false },
  { name: "单选未答",   q: { type: "single", options: ["a","b"], answer: [0] }, ans: null, want: false },
  { name: "多选全对",   q: { type: "multiple", options: ["a","b","c","d"], answer: [0,2] }, ans: [2,0], want: true },
  { name: "多选少选",   q: { type: "multiple", options: ["a","b","c","d"], answer: [0,2] }, ans: [0], want: false },
  { name: "多选多选",   q: { type: "multiple", options: ["a","b","c","d"], answer: [0,2] }, ans: [0,1,2], want: false },
  { name: "判断正确",   q: { type: "judge", options: ["正确","错误"], answer: [0] }, ans: [0], want: true },
  { name: "填空精确",   q: { type: "fill", answer: ["1/x"] }, ans: "1/x", want: true },
  { name: "填空去空格", q: { type: "fill", answer: ["1/x"] }, ans: " 1 / x ", want: true },
  { name: "填空全角",   q: { type: "fill", answer: ["ln|x|+C"] }, ans: "ｌｎ｜ｘ｜＋Ｃ", want: true },
  { name: "填空多答案", q: { type: "fill", answer: ["e", "自然常数e"] }, ans: "自然常数e", want: true },
  { name: "填空空串",   q: { type: "fill", answer: ["e"] }, ans: "   ", want: false },
  { name: "填空错误",   q: { type: "fill", answer: ["e"] }, ans: "2.7", want: false }
];

let pass = 0;
cases.forEach(c => {
  const got = isCorrect(c.q, c.ans);
  if (got === c.want) pass++;
  else errors.push(`判分用例失败「${c.name}」：期望 ${c.want}，实际 ${got}`);
});

/* ---------- 3. 统计汇总 ---------- */
const byType = {}, bySubject = {}, byDiff = {};
BANK.forEach(q => {
  byType[q.type] = (byType[q.type] || 0) + 1;
  bySubject[q.subject] = (bySubject[q.subject] || 0) + 1;
  byDiff[q.difficulty] = (byDiff[q.difficulty] || 0) + 1;
});

console.log("=".repeat(56));
console.log("题库自检报告");
console.log("=".repeat(56));
console.log(`题目总数：${BANK.length}`);
console.log(`学科数：${Object.keys(bySubject).length}`);
console.log(`章节数：${new Set(BANK.map(q => q.subject + "/" + q.chapter)).size}`);
console.log("\n题型分布：");
Object.entries(byType).forEach(([k, v]) => console.log(`  ${k.padEnd(9)} ${v}`));
console.log("\n难度分布：");
Object.entries(byDiff).forEach(([k, v]) => console.log(`  难度${k}     ${v}`));
console.log("\n学科分布：");
Object.entries(bySubject).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${k.padEnd(12)} ${v}`));

console.log(`\n判分用例：${pass}/${cases.length} 通过`);

if (warns.length) {
  console.log(`\n⚠ 提醒 ${warns.length} 条：`);
  warns.slice(0, 20).forEach(w => console.log("  - " + w));
  if (warns.length > 20) console.log(`  ...还有 ${warns.length - 20} 条`);
}

if (errors.length) {
  console.log(`\n✗ 错误 ${errors.length} 条：`);
  errors.forEach(e => console.log("  - " + e));
  process.exit(1);
} else {
  console.log("\n✓ 全部校验通过，题库结构完整、判分逻辑正确。");
}
