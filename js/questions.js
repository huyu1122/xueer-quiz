/**
 * 学而刷题 —— 题库数据
 * 题型: single(单选) | multiple(多选) | judge(判断) | fill(填空)
 * 答案: 选择题存选项下标数组; 判断题 0=正确 1=错误; 填空题存可接受答案字符串数组
 * 难度: 1=基础 2=中等 3=较难
 * knowledge: 知识点标签（受控词表），用于掌握度统计与针对性练习
 * 文本中 $...$ 与 $$...$$ 会渲染为 LaTeX 公式（KaTeX）
 */
const QUESTION_BANK = [

  /* ================= 高等数学 ================= */
  {
    id: "m-001",
    subject: "高等数学",
    chapter: "极限与连续",
    knowledge: ["重要极限","等价无穷小"],
    type: "single",
    difficulty: 1,
    stem: "极限 $\\lim\\limits_{x \\to 0} \\dfrac{\\sin x}{x}$ 的值为：",
    options: ["$0$","$1$","$\\infty$","不存在"],
    answer: [1],
    analysis: "这是第一个重要极限。当 $x \\to 0$ 时 $\\sin x$ 与 $x$ 是等价无穷小，故 $\\dfrac{\\sin x}{x} \\to 1$。"
  },
  {
    id: "m-002",
    subject: "高等数学",
    chapter: "极限与连续",
    knowledge: ["重要极限"],
    type: "single",
    difficulty: 1,
    stem: "极限 $\\lim\\limits_{x \\to \\infty} \\left(1 + \\dfrac{1}{x}\\right)^{x}$ 的值为：",
    options: ["$1$","$e$","$e^{2}$","$\\infty$"],
    answer: [1],
    analysis: "这是第二个重要极限，其值为自然常数 $e \\approx 2.71828$。"
  },
  {
    id: "m-003",
    subject: "高等数学",
    chapter: "极限与连续",
    knowledge: ["等价无穷小"],
    type: "single",
    difficulty: 2,
    stem: "当 $x \\to 0$ 时，$1 - \\cos x$ 与下列哪个量是同阶无穷小？",
    options: ["$x$","$x^{2}$","$x^{3}$","$\\sqrt{x}$"],
    answer: [1],
    analysis: "由 $1 - \\cos x = 2\\sin^{2}\\dfrac{x}{2} \\sim \\dfrac{x^{2}}{2}$ 可知，它与 $x^{2}$ 是同阶（且等价）无穷小。"
  },
  {
    id: "m-004",
    subject: "高等数学",
    chapter: "极限与连续",
    knowledge: ["连续与可导"],
    type: "judge",
    difficulty: 1,
    stem: "判断：函数在某点可导，则它在该点必定连续。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "可导必连续，这是导数定义直接推出的结论；但反之不成立。"
  },
  {
    id: "m-005",
    subject: "高等数学",
    chapter: "极限与连续",
    knowledge: ["连续与可导"],
    type: "judge",
    difficulty: 2,
    stem: "判断：函数在某点连续，则它在该点必定可导。",
    options: ["正确","错误"],
    answer: [1],
    analysis: "连续不一定可导。典型反例：$f(x)=|x|$ 在 $x=0$ 处连续但不可导（左右导数不相等）。"
  },
  {
    id: "m-006",
    subject: "高等数学",
    chapter: "导数与微分",
    knowledge: ["连续与可导","导数定义"],
    type: "single",
    difficulty: 1,
    stem: "函数 $f(x) = |x|$ 在 $x = 0$ 处的性质是：",
    options: ["连续且可导","连续但不可导","不连续但可导","既不连续也不可导"],
    answer: [1],
    analysis: "$|x|$ 在 $0$ 处左右极限都等于 $0$，故连续；但左导数为 $-1$、右导数为 $1$，不相等，故不可导。"
  },
  {
    id: "m-007",
    subject: "高等数学",
    chapter: "导数与微分",
    knowledge: ["基本求导公式"],
    type: "single",
    difficulty: 1,
    stem: "求导：$\\dfrac{d}{dx}(\\ln x) = $",
    options: ["$\\dfrac{1}{x}$","$x$","$-\\dfrac{1}{x^{2}}$","$\\ln x$"],
    answer: [0],
    analysis: "自然对数函数的导数为 $\\dfrac{1}{x}$（$x > 0$）。"
  },
  {
    id: "m-008",
    subject: "高等数学",
    chapter: "导数与微分",
    knowledge: ["极值与最值"],
    type: "single",
    difficulty: 2,
    stem: "若 $f'(x_0) = 0$，则 $x_0$ 一定是 $f(x)$ 的极值点。该说法：",
    options: ["正确","错误，还需二阶导数等条件判断"],
    answer: [1],
    analysis: "驻点不一定是极值点。反例：$f(x)=x^{3}$ 在 $x=0$ 处 $f'(0)=0$，但 $0$ 不是极值点。"
  },
  {
    id: "m-009",
    subject: "高等数学",
    chapter: "导数与微分",
    knowledge: ["微分中值定理"],
    type: "multiple",
    difficulty: 2,
    stem: "罗尔定理成立需要满足的条件包括（多选）：",
    options: ["$f(x)$ 在闭区间 $[a,b]$ 上连续","$f(x)$ 在开区间 $(a,b)$ 内可导","$f(a) = f(b)$","$f(x)$ 在 $[a,b]$ 上单调"],
    answer: [0,1,2],
    analysis: "罗尔定理三条件：闭区间连续、开区间可导、端点函数值相等。单调性不是前提。"
  },
  {
    id: "m-010",
    subject: "高等数学",
    chapter: "导数与微分",
    knowledge: ["凹凸性与拐点"],
    type: "single",
    difficulty: 2,
    stem: "曲线 $y = f(x)$ 的拐点是：",
    options: ["$f'(x)=0$ 的点","$f''(x)=0$ 的点","凹凸性发生改变的点","函数值最大的点"],
    answer: [2],
    analysis: "拐点是曲线凹凸性发生改变的点。$f''(x)=0$ 只是必要条件（候选点），需进一步判断两侧二阶导数是否变号。"
  },
  {
    id: "m-011",
    subject: "高等数学",
    chapter: "不定积分",
    knowledge: ["基本积分公式"],
    type: "single",
    difficulty: 1,
    stem: "求积分：$\\displaystyle\\int \\dfrac{1}{x}\\,dx = $",
    options: ["$\\ln x + C$","$\\ln|x| + C$","$-\\dfrac{1}{x^{2}} + C$","$\\dfrac{1}{x} + C$"],
    answer: [1],
    analysis: "注意定义域：$x$ 可能为负，因此正确结果是 $\\ln|x| + C$。"
  },
  {
    id: "m-012",
    subject: "高等数学",
    chapter: "不定积分",
    knowledge: ["基本积分公式"],
    type: "single",
    difficulty: 1,
    stem: "求积分：$\\displaystyle\\int e^{x}\\,dx = $",
    options: ["$e^{x} + C$","$\\dfrac{e^{x}}{x} + C$","$xe^{x} + C$","$\\ln x + C$"],
    answer: [0],
    analysis: "$e^{x}$ 的导数与积分都是它本身。"
  },
  {
    id: "m-013",
    subject: "高等数学",
    chapter: "定积分",
    knowledge: ["定积分计算"],
    type: "single",
    difficulty: 2,
    stem: "定积分 $\\displaystyle\\int_{0}^{1} x^{2}\\,dx$ 的值为：",
    options: ["$\\dfrac{1}{2}$","$\\dfrac{1}{3}$","$\\dfrac{1}{4}$","$1$"],
    answer: [1],
    analysis: "$\\displaystyle\\int_{0}^{1} x^{2}\\,dx = \\left[\\dfrac{x^{3}}{3}\\right]_{0}^{1} = \\dfrac{1}{3}$。"
  },
  {
    id: "m-014",
    subject: "高等数学",
    chapter: "定积分",
    knowledge: ["定积分计算"],
    type: "single",
    difficulty: 2,
    stem: "$\\displaystyle\\int_{0}^{\\pi} \\sin x\\,dx = $",
    options: ["$0$","$1$","$2$","$\\pi$"],
    answer: [2],
    analysis: "$\\displaystyle\\int_{0}^{\\pi} \\sin x\\,dx = \\big[-\\cos x\\big]_{0}^{\\pi} = -(-1) - (-1) = 2$。"
  },
  {
    id: "m-015",
    subject: "高等数学",
    chapter: "级数",
    knowledge: ["无穷级数"],
    type: "single",
    difficulty: 3,
    stem: "级数 $\\displaystyle\\sum_{n=1}^{\\infty} \\dfrac{1}{n^{2}}$ 的敛散性与和为：",
    options: ["发散","收敛，和为 $\\dfrac{\\pi^{2}}{6}$","收敛，和为 $1$","收敛，和为 $e$"],
    answer: [1],
    analysis: "这是 $p$ 级数 $p=2>1$ 的情形，收敛；欧拉证明了其和为 $\\dfrac{\\pi^{2}}{6} \\approx 1.6449$。"
  },

  /* ================= 线性代数 ================= */
  {
    id: "l-001",
    subject: "线性代数",
    chapter: "矩阵运算",
    knowledge: ["矩阵运算"],
    type: "judge",
    difficulty: 1,
    stem: "判断：矩阵乘法一般不满足交换律，即 AB ≠ BA。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "矩阵乘法满足结合律与分配律，但不满足交换律，且 AB 有意义时 BA 未必有意义。"
  },
  {
    id: "l-002",
    subject: "线性代数",
    chapter: "矩阵运算",
    knowledge: ["矩阵运算","矩阵转置"],
    type: "single",
    difficulty: 2,
    stem: "设 A、B 为同阶方阵，则 (AB)ᵀ = ",
    options: ["AᵀBᵀ","BᵀAᵀ","AB","BA"],
    answer: [1],
    analysis: "转置的乘法法则是「反序」： (AB)ᵀ = BᵀAᵀ。"
  },
  {
    id: "l-003",
    subject: "线性代数",
    chapter: "行列式",
    knowledge: ["矩阵可逆性"],
    type: "single",
    difficulty: 2,
    stem: "方阵 A 可逆的充分必要条件是：",
    options: ["|A| = 0","|A| ≠ 0","A 是对称矩阵","A 的元素全非零"],
    answer: [1],
    analysis: "A 可逆 ⟺ |A| ≠ 0 ⟺ r(A) = n ⟺ A 的列向量组线性无关。"
  },
  {
    id: "l-004",
    subject: "线性代数",
    chapter: "行列式",
    knowledge: ["行列式性质"],
    type: "judge",
    difficulty: 1,
    stem: "判断：交换行列式的任意两行，行列式的值变号。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "这是行列式的基本性质之一；推论是若两行相同则行列式为 0。"
  },
  {
    id: "l-005",
    subject: "线性代数",
    chapter: "行列式",
    knowledge: ["行列式性质"],
    type: "single",
    difficulty: 2,
    stem: "设 A 为 n 阶方阵，则 |Aᵀ| 与 |A| 的关系是：",
    options: ["|Aᵀ| = |A|","|Aᵀ| = −|A|","|Aᵀ| = |A|²","无确定关系"],
    answer: [0],
    analysis: "行列式转置不变，即 |Aᵀ| = |A|。"
  },
  {
    id: "l-006",
    subject: "线性代数",
    chapter: "特征值",
    knowledge: ["特征值与特征向量"],
    type: "judge",
    difficulty: 2,
    stem: "判断：若方阵 A 有零特征值，则 A 不可逆。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "|A| 等于全部特征值之积，含零特征值则 |A|=0，故 A 不可逆。"
  },
  {
    id: "l-007",
    subject: "线性代数",
    chapter: "特征值",
    knowledge: ["特征值与特征向量"],
    type: "single",
    difficulty: 2,
    stem: "n 阶方阵 A 所有特征值之和等于：",
    options: ["|A|","A 的主对角线元素之和（迹）","r(A)","0"],
    answer: [1],
    analysis: "特征值之和等于矩阵的迹 tr(A)，特征值之积等于 |A|。"
  },
  {
    id: "l-008",
    subject: "线性代数",
    chapter: "向量组",
    knowledge: ["向量组线性相关性"],
    type: "single",
    difficulty: 2,
    stem: "向量组 α₁, α₂, …, αₛ 线性相关的充要条件是：",
    options: ["其中每个向量都非零","存在不全为零的数 k₁…kₛ 使 ∑kᵢαᵢ = 0","向量个数 s > 1","向量组秩等于 s"],
    answer: [1],
    analysis: "线性相关的定义即存在不全为零的系数使线性组合为零向量；秩等于 s 时是线性无关。"
  },
  {
    id: "l-009",
    subject: "线性代数",
    chapter: "向量组",
    knowledge: ["向量组线性相关性"],
    type: "single",
    difficulty: 3,
    stem: "设向量组含 s 个 n 维向量，若 s > n，则该向量组：",
    options: ["必定线性无关","必定线性相关","可能无关也可能相关","无法判断"],
    answer: [1],
    analysis: "向量个数超过维数时必线性相关，因为秩 r ≤ n < s。"
  },
  {
    id: "l-010",
    subject: "线性代数",
    chapter: "线性方程组",
    knowledge: ["线性方程组"],
    type: "single",
    difficulty: 2,
    stem: "n 元线性方程组 Ax = b 有唯一解的充要条件是：",
    options: ["r(A) = r(A|b) < n","r(A) = r(A|b) = n","r(A) < n","|A| = 0"],
    answer: [1],
    analysis: "有解要求 r(A)=r(A|b)；唯一解进一步要求秩等于未知数个数 n。"
  },

  /* ================= 概率论与数理统计 ================= */
  {
    id: "p-001",
    subject: "概率论与数理统计",
    chapter: "古典概型",
    knowledge: ["古典概型"],
    type: "single",
    difficulty: 1,
    stem: "同时掷两枚均匀硬币，恰好出现一个正面的概率是：",
    options: ["1/4","1/3","1/2","3/4"],
    answer: [2],
    analysis: "样本空间为 {正正, 正反, 反正, 反反} 共 4 个等可能结果，恰好一个正面的有 2 个，故概率为 2/4 = 1/2。"
  },
  {
    id: "p-002",
    subject: "概率论与数理统计",
    chapter: "条件概率",
    knowledge: ["条件概率"],
    type: "single",
    difficulty: 2,
    stem: "设 P(B) > 0，则条件概率 P(A|B) 等于：",
    options: ["P(AB)/P(B)","P(A)P(B)","P(A)/P(B)","P(A∪B)"],
    answer: [0],
    analysis: "条件概率定义为 P(A|B) = P(AB)/P(B)，要求 P(B) > 0。"
  },
  {
    id: "p-003",
    subject: "概率论与数理统计",
    chapter: "独立性",
    knowledge: ["事件独立性"],
    type: "judge",
    difficulty: 2,
    stem: "判断：若事件 A、B 相互独立，则 P(AB) = P(A)P(B)。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "这正是两事件相互独立的定义（等价于 P(A|B)=P(A)，当 P(B)>0）。"
  },
  {
    id: "p-004",
    subject: "概率论与数理统计",
    chapter: "独立性",
    knowledge: ["事件独立性","互斥与独立"],
    type: "judge",
    difficulty: 3,
    stem: "判断：若事件 A、B 互斥（互不相容），则 A、B 一定相互独立。",
    options: ["正确","错误"],
    answer: [1],
    analysis: "互斥意味着 P(AB)=0。若 P(A)>0 且 P(B)>0，则 P(A)P(B)>0 ≠ 0，故并不独立。互斥与独立是两个不同的概念。"
  },
  {
    id: "p-005",
    subject: "概率论与数理统计",
    chapter: "随机变量数字特征",
    knowledge: ["数学期望"],
    type: "single",
    difficulty: 2,
    stem: "设 X 为随机变量，a、b 为常数，则 E(aX + b) = ",
    options: ["aE(X) + b","aE(X) + ab","aE(X)","E(X) + b"],
    answer: [0],
    analysis: "数学期望具有线性性质：E(aX+b) = aE(X) + b。"
  },
  {
    id: "p-006",
    subject: "概率论与数理统计",
    chapter: "随机变量数字特征",
    knowledge: ["方差"],
    type: "single",
    difficulty: 3,
    stem: "设 X 为随机变量，a、b 为常数，则 D(aX + b) = ",
    options: ["aD(X) + b","a²D(X)","a²D(X) + b","aD(X)"],
    answer: [1],
    analysis: "方差对常数加项不敏感，对系数要平方：D(aX+b) = a²D(X)。"
  },
  {
    id: "p-007",
    subject: "概率论与数理统计",
    chapter: "常见分布",
    knowledge: ["常见分布"],
    type: "single",
    difficulty: 2,
    stem: "标准正态分布的记号和参数是：",
    options: ["N(1, 0)","N(0, 1)","N(0, 0)","N(1, 1)"],
    answer: [1],
    analysis: "正态分布 N(μ, σ²)，标准正态分布指 μ=0、σ²=1，即 N(0,1)。"
  },
  {
    id: "p-008",
    subject: "概率论与数理统计",
    chapter: "常见分布",
    knowledge: ["常见分布","随机变量标准化"],
    type: "single",
    difficulty: 2,
    stem: "若 X ~ N(μ, σ²)，则 (X − μ)/σ 服从：",
    options: ["N(μ, σ²)","N(0, 1)","N(0, σ²)","均匀分布"],
    answer: [1],
    analysis: "标准化变换后服从标准正态分布 N(0,1)。"
  },
  {
    id: "p-009",
    subject: "概率论与数理统计",
    chapter: "大数定律与中心极限定理",
    knowledge: ["中心极限定理"],
    type: "single",
    difficulty: 3,
    stem: "中心极限定理主要说明：",
    options: ["独立同分布随机变量之和的标准化近似服从正态分布","随机变量一定有期望","样本均值等于总体均值","方差一定存在"],
    answer: [0],
    analysis: "在独立同分布且方差有限的条件下，n 充分大时样本均值（或和的标准化）近似服从正态分布。"
  },

  /* ================= 大学英语 ================= */
  {
    id: "e-001",
    subject: "大学英语",
    chapter: "词汇辨析",
    knowledge: ["词汇辨析"],
    type: "single",
    difficulty: 1,
    stem: "The word \"abandon\" most probably means:",
    options: ["to give up completely","to take care of","to increase quickly","to remember clearly"],
    answer: [0],
    analysis: "abandon 意为「放弃、抛弃」，与 give up completely 对应。"
  },
  {
    id: "e-002",
    subject: "大学英语",
    chapter: "词汇辨析",
    knowledge: ["词汇辨析"],
    type: "single",
    difficulty: 2,
    stem: "Choose the word closest in meaning to \"compulsory\":",
    options: ["optional","required","temporary","complicated"],
    answer: [1],
    analysis: "compulsory 意为「强制的、必修的」，与 required 同义；optional 是它的反义词。"
  },
  {
    id: "e-003",
    subject: "大学英语",
    chapter: "词汇辨析",
    knowledge: ["词汇辨析"],
    type: "single",
    difficulty: 2,
    stem: "His explanation was so ______ that nobody could understand it.",
    options: ["ambiguous","obvious","transparent","frank"],
    answer: [0],
    analysis: "由后半句「没人能听懂」可知需要表示「模糊不清」的词，ambiguous 意为「模棱两可的」。"
  },
  {
    id: "e-004",
    subject: "大学英语",
    chapter: "虚拟语气",
    knowledge: ["虚拟语气"],
    type: "single",
    difficulty: 2,
    stem: "If I ______ you, I would accept the offer.",
    options: ["am","was","were","will be"],
    answer: [2],
    analysis: "与现在事实相反的虚拟条件句，从句用过去式，be 动词统一用 were。"
  },
  {
    id: "e-005",
    subject: "大学英语",
    chapter: "虚拟语气",
    knowledge: ["虚拟语气"],
    type: "single",
    difficulty: 3,
    stem: "The professor suggested that the students ______ the experiment again.",
    options: ["did","do","does","doing"],
    answer: [1],
    analysis: "suggest 表示「建议」时，宾语从句用 (should) + 动词原形的虚拟语气。"
  },
  {
    id: "e-006",
    subject: "大学英语",
    chapter: "时态语态",
    knowledge: ["时态与语态"],
    type: "single",
    difficulty: 2,
    stem: "By the time we arrived, the lecture ______ already ______.",
    options: ["has / begun","had / begun","was / beginning","would / begin"],
    answer: [1],
    analysis: "「过去的过去」用过去完成时 had + 过去分词，begin 的过去分词是 begun。"
  },
  {
    id: "e-007",
    subject: "大学英语",
    chapter: "时态语态",
    knowledge: ["时态与语态","被动语态"],
    type: "single",
    difficulty: 2,
    stem: "The new library ______ by the end of next year.",
    options: ["will complete","will be completed","is completing","has completed"],
    answer: [1],
    analysis: "图书馆是「被建成」的，且时间为将来，故用一般将来时的被动语态 will be completed。"
  },
  {
    id: "e-008",
    subject: "大学英语",
    chapter: "固定搭配",
    knowledge: ["固定搭配"],
    type: "single",
    difficulty: 2,
    stem: "Students are required to ______ full advantage of the library resources.",
    options: ["take","make","get","do"],
    answer: [0],
    analysis: "固定搭配 take advantage of，意为「利用」。"
  },
  {
    id: "e-009",
    subject: "大学英语",
    chapter: "定语从句",
    knowledge: ["定语从句"],
    type: "single",
    difficulty: 2,
    stem: "This is the laboratory ______ we carried out the research last term.",
    options: ["which","where","that","who"],
    answer: [1],
    analysis: "先行词是表示地点的 laboratory，从句中缺地点状语，故用关系副词 where（= in which）。"
  },
  {
    id: "e-010",
    subject: "大学英语",
    chapter: "非谓语动词",
    knowledge: ["非谓语动词"],
    type: "single",
    difficulty: 3,
    stem: "______ from the top of the hill, the campus looks like a beautiful garden.",
    options: ["Seeing","Seen","To see","Having seen"],
    answer: [1],
    analysis: "campus 与 see 之间是被动关系（校园被看），故用过去分词 Seen 作状语。"
  },

  /* ================= 计算机基础 ================= */
  {
    id: "c-001",
    subject: "计算机基础",
    chapter: "数据表示",
    knowledge: ["数制转换","存储单位"],
    type: "single",
    difficulty: 1,
    stem: "在计算机中，1 KB 等于多少字节（Byte）？",
    options: ["1000","1024","512","2048"],
    answer: [1],
    analysis: "计算机采用二进制，1 KB = 2¹⁰ B = 1024 B。（硬盘厂商有时按 1000 计算，属十进制标称。）"
  },
  {
    id: "c-002",
    subject: "计算机基础",
    chapter: "数据表示",
    knowledge: ["数制转换"],
    type: "single",
    difficulty: 1,
    stem: "二进制数 1011 转换为十进制是：",
    options: ["9","11","13","15"],
    answer: [1],
    analysis: "1×2³ + 0×2² + 1×2¹ + 1×2⁰ = 8 + 0 + 2 + 1 = 11。"
  },
  {
    id: "c-003",
    subject: "计算机基础",
    chapter: "数据表示",
    knowledge: ["数制转换"],
    type: "single",
    difficulty: 2,
    stem: "十进制数 25 转换为二进制是：",
    options: ["11001","10101","11010","10011"],
    answer: [0],
    analysis: "25 = 16 + 8 + 1 = 11001₂。"
  },
  {
    id: "c-004",
    subject: "计算机基础",
    chapter: "操作系统",
    knowledge: ["操作系统"],
    type: "multiple",
    difficulty: 2,
    stem: "下列属于操作系统主要功能的有（多选）：",
    options: ["进程管理","存储管理","文件管理","编译高级语言源代码"],
    answer: [0,1,2],
    analysis: "操作系统负责进程、存储、文件、设备管理及用户接口；编译源代码是编译器的职责。"
  },
  {
    id: "c-005",
    subject: "计算机基础",
    chapter: "计算机网络",
    knowledge: ["计算机网络","网络分层"],
    type: "single",
    difficulty: 2,
    stem: "TCP/IP 模型中，IP 协议工作在：",
    options: ["应用层","传输层","网际层（网络层）","网络接口层"],
    answer: [2],
    analysis: "IP 是网际层协议，负责寻址与路由；TCP 属于传输层，HTTP 属于应用层。"
  },
  {
    id: "c-006",
    subject: "计算机基础",
    chapter: "计算机网络",
    knowledge: ["计算机网络","网络协议"],
    type: "single",
    difficulty: 2,
    stem: "HTTP 协议默认使用的端口号是：",
    options: ["21","25","80","443"],
    answer: [2],
    analysis: "HTTP 默认端口 80；HTTPS 默认 443；FTP 为 21；SMTP 为 25。"
  },
  {
    id: "c-007",
    subject: "计算机基础",
    chapter: "计算机网络",
    knowledge: ["计算机网络","网络协议"],
    type: "single",
    difficulty: 2,
    stem: "TCP 与 UDP 的主要区别是：",
    options: ["TCP 面向连接可靠传输，UDP 无连接不保证可靠","TCP 速度一定更快","UDP 不能用于视频","两者完全相同"],
    answer: [0],
    analysis: "TCP 提供面向连接的可靠字节流服务；UDP 无连接、开销小但不保证可靠，适合实时音视频等场景。"
  },
  {
    id: "c-008",
    subject: "计算机基础",
    chapter: "数据库",
    knowledge: ["数据库基础"],
    type: "single",
    difficulty: 2,
    stem: "SQL 中用于从表中查询数据的关键字是：",
    options: ["SELECT","UPDATE","INSERT","DELETE"],
    answer: [0],
    analysis: "SELECT 用于查询；INSERT 插入、UPDATE 更新、DELETE 删除，合称增删改查（CRUD）。"
  },

  /* ================= 数据结构 ================= */
  {
    id: "d-001",
    subject: "数据结构",
    chapter: "线性表",
    knowledge: ["栈与队列"],
    type: "single",
    difficulty: 1,
    stem: "栈（Stack）的存取特点是：",
    options: ["先进先出","后进先出","随机存取","按优先级存取"],
    answer: [1],
    analysis: "栈是 LIFO（Last In First Out）结构，只允许在栈顶插入和删除。"
  },
  {
    id: "d-002",
    subject: "数据结构",
    chapter: "线性表",
    knowledge: ["栈与队列"],
    type: "single",
    difficulty: 1,
    stem: "队列（Queue）的存取特点是：",
    options: ["先进先出","后进先出","随机存取","双向存取"],
    answer: [0],
    analysis: "队列是 FIFO（First In First Out）结构，队尾入队、队头出队。"
  },
  {
    id: "d-003",
    subject: "数据结构",
    chapter: "线性表",
    knowledge: ["线性表"],
    type: "single",
    difficulty: 2,
    stem: "与数组相比，链表的主要优势是：",
    options: ["支持随机访问","插入和删除元素效率高","占用内存更少","查找速度更快"],
    answer: [1],
    analysis: "链表插入删除只需修改指针，为 O(1)（已知位置时）；但链表不支持随机访问，查找需 O(n)。"
  },
  {
    id: "d-004",
    subject: "数据结构",
    chapter: "树",
    knowledge: ["树与二叉树","二叉搜索树"],
    type: "single",
    difficulty: 2,
    stem: "对二叉搜索树（BST）进行中序遍历，得到的序列是：",
    options: ["无序的","递增有序的","递减有序的","按层次排列的"],
    answer: [1],
    analysis: "BST 满足左子树 < 根 < 右子树，中序遍历（左-根-右）恰好得到递增有序序列。"
  },
  {
    id: "d-005",
    subject: "数据结构",
    chapter: "树",
    knowledge: ["树与二叉树","二叉树性质"],
    type: "single",
    difficulty: 3,
    stem: "一棵有 n 个结点的完全二叉树，其深度（层数）为：",
    options: ["⌊log₂n⌋ + 1","n / 2","log₂n","n − 1"],
    answer: [0],
    analysis: "完全二叉树深度为 ⌊log₂n⌋ + 1（根结点所在层为第 1 层）。"
  },
  {
    id: "d-006",
    subject: "数据结构",
    chapter: "树",
    knowledge: ["树与二叉树","二叉树性质"],
    type: "single",
    difficulty: 2,
    stem: "一棵二叉树中，度为 2 的结点数为 5，则叶子结点数为：",
    options: ["4","5","6","无法确定"],
    answer: [2],
    analysis: "二叉树性质：叶子数 n₀ = 度为 2 的结点数 n₂ + 1 = 5 + 1 = 6。"
  },
  {
    id: "d-007",
    subject: "数据结构",
    chapter: "排序",
    knowledge: ["排序算法","算法复杂度"],
    type: "single",
    difficulty: 2,
    stem: "快速排序的平均时间复杂度是：",
    options: ["O(n)","O(n log n)","O(n²)","O(log n)"],
    answer: [1],
    analysis: "快排平均 O(n log n)；最坏情况（每次划分极不平衡）退化为 O(n²)。"
  },
  {
    id: "d-008",
    subject: "数据结构",
    chapter: "排序",
    knowledge: ["排序算法","算法复杂度"],
    type: "single",
    difficulty: 2,
    stem: "冒泡排序在最坏情况下的时间复杂度是：",
    options: ["O(n)","O(n log n)","O(n²)","O(log n)"],
    answer: [2],
    analysis: "最坏（逆序）需进行约 n(n−1)/2 次比较与交换，故为 O(n²)。"
  },
  {
    id: "d-009",
    subject: "数据结构",
    chapter: "排序",
    knowledge: ["排序算法","算法复杂度"],
    type: "multiple",
    difficulty: 3,
    stem: "下列排序算法中，平均时间复杂度为 O(n log n) 的有（多选）：",
    options: ["快速排序","归并排序","堆排序","直接插入排序"],
    answer: [0,1,2],
    analysis: "快排、归并、堆排序平均均为 O(n log n)；直接插入排序平均为 O(n²)。"
  },
  {
    id: "d-010",
    subject: "数据结构",
    chapter: "查找",
    knowledge: ["查找算法","算法复杂度"],
    type: "single",
    difficulty: 2,
    stem: "对长度为 n 的有序表进行二分查找，时间复杂度为：",
    options: ["O(1)","O(log n)","O(n)","O(n log n)"],
    answer: [1],
    analysis: "每次比较将查找区间缩小一半，最多比较 ⌈log₂(n+1)⌉ 次，故为 O(log n)。"
  },
  {
    id: "d-011",
    subject: "数据结构",
    chapter: "图",
    knowledge: ["图论基础"],
    type: "single",
    difficulty: 3,
    stem: "具有 n 个顶点的无向完全图，其边数为：",
    options: ["n(n−1)/2","n(n−1)","n²","n−1"],
    answer: [0],
    analysis: "每两个顶点之间恰有一条边，组合数 C(n,2) = n(n−1)/2。"
  },

  /* ================= 大学物理 ================= */
  {
    id: "ph-001",
    subject: "大学物理",
    chapter: "质点运动学",
    knowledge: ["牛顿运动定律"],
    type: "single",
    difficulty: 1,
    stem: "牛顿第二定律的表达式是：",
    options: ["F = ma","F = mv","F = m/a","F = a/m"],
    answer: [0],
    analysis: "牛顿第二定律：物体加速度与合外力成正比、与质量成反比，即 F = ma。"
  },
  {
    id: "ph-002",
    subject: "大学物理",
    chapter: "动量守恒",
    knowledge: ["动量守恒"],
    type: "single",
    difficulty: 2,
    stem: "系统动量守恒的条件是：",
    options: ["系统不受外力或合外力为零","系统动能守恒","系统内无摩擦","系统机械能守恒"],
    answer: [0],
    analysis: "动量守恒条件是合外力为零（或外力远小于内力可忽略）。注意动量守恒与机械能守恒是两回事。"
  },
  {
    id: "ph-003",
    subject: "大学物理",
    chapter: "机械能",
    knowledge: ["机械能守恒"],
    type: "judge",
    difficulty: 2,
    stem: "判断：只有保守力做功时，系统的机械能守恒。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "机械能守恒条件：除重力、弹力等保守力外，其他力不做功（或做功代数和为零）。"
  },
  {
    id: "ph-004",
    subject: "大学物理",
    chapter: "稳恒电流",
    knowledge: ["电路基础"],
    type: "single",
    difficulty: 1,
    stem: "两个电阻 R₁、R₂ 串联后的总电阻为：",
    options: ["R₁ + R₂","R₁R₂/(R₁+R₂)","1/(R₁+R₂)","R₁ − R₂"],
    answer: [0],
    analysis: "串联电阻相加：R = R₁ + R₂；并联才是 R₁R₂/(R₁+R₂)。"
  },
  {
    id: "ph-005",
    subject: "大学物理",
    chapter: "静电场",
    knowledge: ["静电场"],
    type: "single",
    difficulty: 2,
    stem: "点电荷 q 在距离 r 处产生的电场强度大小为（k 为静电力常量）：",
    options: ["kq/r","kq/r²","kq²/r²","kq/r³"],
    answer: [1],
    analysis: "点电荷场强公式 E = kq/r²，方向沿连线（正电荷向外）。"
  },
  {
    id: "ph-006",
    subject: "大学物理",
    chapter: "光的干涉",
    knowledge: ["光的干涉"],
    type: "single",
    difficulty: 2,
    stem: "在双缝干涉实验中，相邻两条明纹的间距 Δx 与波长 λ 的关系是：",
    options: ["Δx 与 λ 成正比","Δx 与 λ 成反比","Δx 与 λ 无关","Δx 与 λ² 成正比"],
    answer: [0],
    analysis: "由 Δx = Dλ/d 可知，条纹间距与波长成正比，波长越长条纹越宽。"
  },
  {
    id: "ph-007",
    subject: "大学物理",
    chapter: "热学",
    knowledge: ["理想气体"],
    type: "single",
    difficulty: 2,
    stem: "理想气体状态方程为：",
    options: ["pV = nRT","pV = nT","p/V = nRT","V = nRT"],
    answer: [0],
    analysis: "理想气体状态方程 pV = nRT，其中 n 为物质的量，R 为普适气体常量。"
  },
  {
    id: "ph-008",
    subject: "大学物理",
    chapter: "波动",
    knowledge: ["机械波"],
    type: "single",
    difficulty: 3,
    stem: "机械波在介质中传播时，传播的是：",
    options: ["介质质点本身","振动状态（能量与相位）","介质质量","静电场"],
    answer: [1],
    analysis: "波传播的是振动状态与能量，介质质点只在各自平衡位置附近振动，并不随波迁移。"
  },

  /* ================= 思想政治 ================= */
  {
    id: "z-001",
    subject: "思想政治",
    chapter: "马克思主义基本原理",
    knowledge: ["物质与意识"],
    type: "single",
    difficulty: 2,
    stem: "马克思主义哲学认为，世界的本原是：",
    options: ["物质","精神","理念","上帝"],
    answer: [0],
    analysis: "辩证唯物主义认为物质是世界的本原，物质决定意识，意识是物质世界长期发展的产物。"
  },
  {
    id: "z-002",
    subject: "思想政治",
    chapter: "马克思主义基本原理",
    knowledge: ["真理与实践"],
    type: "judge",
    difficulty: 2,
    stem: "判断：实践是检验真理的唯一标准。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "真理是主观与客观相符合，只有实践才能把主观认识与客观实际联系起来加以检验。"
  },
  {
    id: "z-003",
    subject: "思想政治",
    chapter: "马克思主义基本原理",
    knowledge: ["矛盾观"],
    type: "single",
    difficulty: 2,
    stem: "矛盾的两个基本属性是：",
    options: ["同一性和斗争性","普遍性和特殊性","主要和次要","内因和外因"],
    answer: [0],
    analysis: "矛盾即对立统一，同一性（相互依存、相互转化）与斗争性（相互排斥、相互对立）是其基本属性。"
  },

  /* ================= 经济学基础 ================= */
  {
    id: "ec-001",
    subject: "经济学基础",
    chapter: "微观经济学",
    knowledge: ["需求与供给"],
    type: "single",
    difficulty: 2,
    stem: "在其他条件不变时，某商品价格上升，通常会导致其需求量：",
    options: ["增加","减少","不变","先增后减"],
    answer: [1],
    analysis: "这是需求定理：价格与需求量反向变动（吉芬商品等特例除外）。"
  },
  {
    id: "ec-002",
    subject: "经济学基础",
    chapter: "微观经济学",
    knowledge: ["需求价格弹性"],
    type: "single",
    difficulty: 3,
    stem: "需求价格弹性系数 |Ed| > 1 时，该商品需求：",
    options: ["缺乏弹性","富有弹性","单位弹性","完全无弹性"],
    answer: [1],
    analysis: "|Ed| > 1 为富有弹性（如奢侈品）；|Ed| < 1 为缺乏弹性（如生活必需品）；= 1 为单位弹性。"
  },
  {
    id: "ec-003",
    subject: "经济学基础",
    chapter: "宏观经济学",
    knowledge: ["宏观经济核算"],
    type: "single",
    difficulty: 2,
    stem: "国内生产总值（GDP）衡量的是：",
    options: ["一国境内一定时期内生产的最终产品和服务的市场价值","一国居民的全部存款","一国的出口总额","一国的财政收入"],
    answer: [0],
    analysis: "GDP 按国土原则统计，指一定时期内一国（地区）境内生产的全部最终产品和服务的市场价值。"
  },

  /* ================= 管理学基础 ================= */
  {
    id: "mg-001",
    subject: "管理学基础",
    chapter: "管理职能",
    knowledge: ["管理职能"],
    type: "multiple",
    difficulty: 2,
    stem: "管理的四大基本职能包括（多选）：",
    options: ["计划","组织","领导","控制"],
    answer: [0,1,2,3],
    analysis: "法约尔等提出的管理职能通常概括为计划、组织、领导、控制四项。"
  },
  {
    id: "mg-002",
    subject: "管理学基础",
    chapter: "决策",
    knowledge: ["决策理论"],
    type: "single",
    difficulty: 2,
    stem: "西蒙提出的「有限理性」决策模型认为，管理者实际追求的是：",
    options: ["最优解","满意解","随机解","唯一解"],
    answer: [1],
    analysis: "由于信息、时间和认知的限制，决策者遵循「满意原则」而非「最优原则」。"
  },

  /* ================= 法学基础 ================= */
  {
    id: "la-001",
    subject: "法学基础",
    chapter: "宪法",
    knowledge: ["宪法"],
    type: "single",
    difficulty: 2,
    stem: "我国的根本大法是：",
    options: ["宪法","民法典","刑法","教育法"],
    answer: [0],
    analysis: "宪法是国家的根本大法，具有最高法律效力，是其他法律的立法依据。"
  },
  {
    id: "la-002",
    subject: "法学基础",
    chapter: "民法典",
    knowledge: ["民法典"],
    type: "single",
    difficulty: 3,
    stem: "根据《民法典》，完全民事行为能力人的年龄起点一般是：",
    options: ["16 周岁","18 周岁","20 周岁","14 周岁"],
    answer: [1],
    analysis: "十八周岁以上的自然人为成年人，具有完全民事行为能力；十六周岁以上以自己劳动收入为主要生活来源的，视为完全民事行为能力人。"
  },

  /* ================= 高等数学 ================= */
  {
    id: "f-001",
    subject: "高等数学",
    chapter: "导数与微分",
    knowledge: ["基本求导公式"],
    type: "fill",
    difficulty: 1,
    stem: "填空：函数 f(x) = x² 的导数为 f′(x) = ______ 。",
    answer: ["2x","2*x"],
    analysis: "由幂函数求导公式 (xⁿ)′ = n·xⁿ⁻¹，得 (x²)′ = 2x。"
  },
  {
    id: "f-002",
    subject: "高等数学",
    chapter: "不定积分",
    knowledge: ["基本积分公式"],
    type: "fill",
    difficulty: 1,
    stem: "填空：∫ cos x dx = ______ + C。",
    answer: ["sin x","sinx","sin(x)"],
    analysis: "cos x 的原函数是 sin x，因为 (sin x)′ = cos x。"
  },
  {
    id: "f-003",
    subject: "高等数学",
    chapter: "极限与连续",
    knowledge: ["重要极限"],
    type: "fill",
    difficulty: 2,
    stem: "填空：lim(x→0) (sin x)/x = ______ 。",
    answer: ["1"],
    analysis: "第一个重要极限，值为 1。"
  },

  /* ================= 线性代数 ================= */
  {
    id: "f-004",
    subject: "线性代数",
    chapter: "行列式",
    knowledge: ["行列式计算"],
    type: "fill",
    difficulty: 2,
    stem: "填空：二阶行列式 |1 2; 3 4| 的值为 ______ 。",
    answer: ["-2","−2","-2.0"],
    analysis: "二阶行列式 = 1×4 − 2×3 = 4 − 6 = −2（主对角线之积减副对角线之积）。"
  },
  {
    id: "f-005",
    subject: "线性代数",
    chapter: "矩阵运算",
    knowledge: ["矩阵可逆性"],
    type: "fill",
    difficulty: 2,
    stem: "填空：n 阶方阵 A 可逆的充要条件是其行列式 |A| ______ 0（填「等于」或「不等于」）。",
    answer: ["不等于","≠","不为"],
    analysis: "A 可逆 ⟺ |A| ≠ 0。"
  },

  /* ================= 概率论与数理统计 ================= */
  {
    id: "f-006",
    subject: "概率论与数理统计",
    chapter: "常见分布",
    knowledge: ["常见分布","数学期望"],
    type: "fill",
    difficulty: 2,
    stem: "填空：标准正态分布记作 N(0, 1)，其数学期望 E(X) = ______ 。",
    answer: ["0"],
    analysis: "标准正态分布 N(0,1) 的期望为 0，方差为 1。"
  },
  {
    id: "f-007",
    subject: "概率论与数理统计",
    chapter: "随机变量数字特征",
    knowledge: ["方差"],
    type: "fill",
    difficulty: 3,
    stem: "填空：若 X 的方差 D(X) = 4，则 D(2X) = ______ 。",
    answer: ["16"],
    analysis: "D(aX) = a²D(X) = 2² × 4 = 16。"
  },

  /* ================= 计算机基础 ================= */
  {
    id: "f-008",
    subject: "计算机基础",
    chapter: "数据表示",
    knowledge: ["数制转换"],
    type: "fill",
    difficulty: 1,
    stem: "填空：十进制数 10 转换为二进制是 ______ 。",
    answer: ["1010"],
    analysis: "10 = 8 + 2 = 1010₂。"
  },
  {
    id: "f-009",
    subject: "计算机基础",
    chapter: "数据表示",
    knowledge: ["数制转换"],
    type: "fill",
    difficulty: 2,
    stem: "填空：十六进制数 FF 转换为十进制是 ______ 。",
    answer: ["255"],
    analysis: "F 表示 15，故 FF₁₆ = 15×16 + 15 = 255。"
  },

  /* ================= 数据结构 ================= */
  {
    id: "f-010",
    subject: "数据结构",
    chapter: "排序",
    knowledge: ["排序算法","算法复杂度"],
    type: "fill",
    difficulty: 2,
    stem: "填空：冒泡排序在最坏情况下的时间复杂度为 O(______)。（用 n 表示，如 n² 写作 n^2 或 n2）",
    answer: ["n^2","n²","n2","n*n"],
    analysis: "最坏（完全逆序）需约 n(n−1)/2 次比较交换，故为 O(n²)。"
  },
  {
    id: "f-011",
    subject: "数据结构",
    chapter: "树",
    knowledge: ["树与二叉树","二叉树性质"],
    type: "fill",
    difficulty: 2,
    stem: "填空：一棵二叉树中度为 2 的结点有 4 个，则叶子结点有 ______ 个。",
    answer: ["5"],
    analysis: "由 n₀ = n₂ + 1 = 4 + 1 = 5。"
  },

  /* ================= 大学物理 ================= */
  {
    id: "f-012",
    subject: "大学物理",
    chapter: "稳恒电流",
    knowledge: ["电路基础"],
    type: "fill",
    difficulty: 1,
    stem: "填空：两个 10 Ω 的电阻并联后的总电阻为 ______ Ω。",
    answer: ["5","5Ω","5欧","5ohm"],
    analysis: "并联公式 1/R = 1/R₁ + 1/R₂ = 1/10 + 1/10 = 1/5，故 R = 5 Ω。"
  },
  {
    id: "f-013",
    subject: "大学物理",
    chapter: "质点运动学",
    knowledge: ["牛顿运动定律"],
    type: "fill",
    difficulty: 2,
    stem: "填空：自由落体运动中，物体下落的加速度大小约为 ______ m/s²（取整数）。",
    answer: ["9.8","10","9.80"],
    analysis: "重力加速度 g ≈ 9.8 m/s²，粗略计算时常取 10 m/s²。"
  },

  /* ================= 大学英语 ================= */
  {
    id: "f-014",
    subject: "大学英语",
    chapter: "词汇辨析",
    knowledge: ["词汇辨析"],
    type: "fill",
    difficulty: 2,
    stem: "填空：The opposite of \"increase\" is ______ .（填一个英文单词）",
    answer: ["decrease","reduce","decline","diminish"],
    analysis: "increase（增加）的反义词是 decrease（减少），也可用 reduce / decline / diminish。"
  },
  {
    id: "f-015",
    subject: "大学英语",
    chapter: "时态语态",
    knowledge: ["时态与语态"],
    type: "fill",
    difficulty: 2,
    stem: "填空：He ______ (go) to the library yesterday.（用所给词的正确形式填空）",
    answer: ["went"],
    analysis: "yesterday 表明是过去时间，用一般过去时，go 的过去式为 went。"
  },

  /* ================= 经济学基础 ================= */
  {
    id: "f-016",
    subject: "经济学基础",
    chapter: "微观经济学",
    knowledge: ["需求价格弹性"],
    type: "fill",
    difficulty: 3,
    stem: "填空：当需求价格弹性 |Ed| = 1 时，称为 ______ 弹性。",
    answer: ["单位","单位弹性","单一"],
    analysis: "|Ed| = 1 称单位弹性；> 1 富有弹性；< 1 缺乏弹性。"
  },

  /* ================= 学习方法 ================= */
  {
    id: "s-001",
    subject: "学习方法",
    chapter: "记忆规律",
    knowledge: ["记忆规律"],
    type: "single",
    difficulty: 1,
    stem: "根据艾宾浩斯遗忘曲线，遗忘的进程是：",
    options: ["先快后慢","先慢后快","匀速进行","随机波动"],
    answer: [0],
    analysis: "遗忘在学习之后立即开始，最初速度很快，之后逐渐减慢。因此及时复习（如当天、次日）效果最好。"
  },
  {
    id: "s-002",
    subject: "学习方法",
    chapter: "练习策略",
    knowledge: ["间隔重复"],
    type: "single",
    difficulty: 2,
    stem: "「间隔重复」（Spaced Repetition）的核心做法是：",
    options: ["一次性长时间集中复习","把复习分散到逐渐拉长的时间间隔中","只复习新内容","只做难题"],
    answer: [1],
    analysis: "间隔重复通过在遗忘临界点安排复习，用较少总时间获得更牢固的长期记忆。"
  },
  {
    id: "s-003",
    subject: "学习方法",
    chapter: "练习策略",
    knowledge: ["错题归因"],
    type: "judge",
    difficulty: 2,
    stem: "判断：做题后立即核对解析、分析错误原因，比只对答案更有利于提分。",
    options: ["正确","错误"],
    answer: [0],
    analysis: "错题归因（是概念不清、计算失误还是审题问题）决定了后续补救方向，是提分的关键环节。"
  }
];

/* 导出给全局使用（无构建工具，直接挂 window） */
window.QUESTION_BANK = QUESTION_BANK;
