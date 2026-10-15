# 上传到 GitHub 指南

本文档说明如何把「学而刷题」发布到 GitHub。

> **当前状态**：本地仓库**已准备完毕**（分支 `main`，首次提交已完成，身份已配置）。
> 你只需在 GitHub 上创建空仓库，然后执行下面的「步骤 4」推送即可。

---

## 你的推送命令

假设仓库名为 `xueer-quiz`（可自行更改）：

```bash
cd quiz-system
git remote add origin https://github.com/huyu1122/xueer-quiz.git
git push -u origin main
```

> 已配置的提交身份：`huyu1122 <huyu1122@users.noreply.github.com>`
> —— 使用 GitHub 隐私邮箱，你的 QQ 邮箱不会出现在公开的提交历史中。

推送时若要求认证，**密码栏需填 Personal Access Token**（GitHub 已不支持密码推送），
获取方式见下方「步骤 4」。

---

## 一、上传前必须知道的两件事

### 1. 不要上传 `server/data/`

该目录包含**用户账号、密码哈希、会话 token、个人学习进度**，属于隐私数据。
`.gitignore` 已忽略它，但请在上传前确认：

```bash
git status --ignored
# 确认 server/data/ 出现在 ignored 列表中，而不是待提交列表
```

### 2. 不要上传 `node_modules/`

`ws` 仅用于浏览器自动化测试，通过 `npm install` 重建即可。
应用本身**零运行时依赖**，克隆后不装任何东西也能跑。

---

## 二、首次发布步骤

### 步骤 1：在 GitHub 上创建空仓库

1. 打开 <https://github.com/new>
2. 填写仓库名，例如 `xueer-quiz`
3. **不要**勾选 "Add a README file" / ".gitignore" / "license"
   （本地已有这些文件，勾选会导致首次推送冲突）
4. 点击 Create repository

### 步骤 2：配置 Git 身份 ✅ 已完成

```bash
# 已为本仓库配置（未使用 --global，不影响其他项目）
# user.name  = huyu1122
# user.email = huyu1122@users.noreply.github.com
```

### 步骤 3：初始化并提交 ✅ 已完成

本地仓库已初始化（分支 `main`），首次提交包含 62 个文件：

```
d74ca58  feat: 学而刷题 —— 大学生在线刷题系统
```

### 步骤 4：关联远程仓库并推送

```bash
git remote add origin https://github.com/huyu1122/<仓库名>.git
git push -u origin main
```

若提示需要认证，需用 **Personal Access Token**：

1. 打开 <https://github.com/settings/tokens>
2. Generate new token (classic) → 勾选 `repo` 权限 → 生成
3. 推送时用户名填 `huyu1122`，密码栏粘贴该 token

---

## 三、后续更新

```bash
git add -A
git commit -m "描述这次改了什么"
git push
```

---

## 四、建议补充的仓库设置

| 项目 | 建议 |
| --- | --- |
| **About 描述** | 一句话说明项目用途，例如「面向大学生的刷题系统：服务端题库 + 登录同步 + 间隔重复」 |
| **Topics** | `quiz` `education` `nodejs` `vanilla-js` `spaced-repetition` `katex` `chinese` |
| **README 截图** | 建议补几张界面截图（首页、答题、统计、知识点热力图），能显著提升观感 |
| **License** | 已包含 MIT（见 `LICENSE`） |

### 关于截图

README 目前没有截图。建议上传后补充，方法：

1. 启动系统，截取几个界面
2. 在仓库中新建 `docs/screenshots/` 目录并上传图片
3. 在 README 中引用：

```markdown
## 界面预览

![首页](docs/screenshots/home.png)
![答题](docs/screenshots/quiz.png)
![知识点热力图](docs/screenshots/knowledge.png)
```

---

## 五、部署到线上（可选）

若想让别人直接访问，而不必自己运行：

| 方式 | 说明 |
| --- | --- |
| **静态托管** | 只上传 `index.html` + `css/` + `js/` + `vendor/`，用 GitHub Pages 托管。**但这是本地模式**，没有登录与同步功能 |
| **VPS / 云服务器** | 完整功能。需装 Node.js，用 `node server/server.js` 运行，建议配 Nginx 反代 + HTTPS |
| **PaaS**（Railway / Render / Fly.io） | 支持 Node.js，可直接部署 `server/server.js`。注意：免费套餐的磁盘通常**不持久**，JSON 文件存储会丢失 |

> ⚠️ **部署到公网前务必阅读 README 的「安全说明」章节**：
> 需设置 `QUIZ_TRUST_PROXY=1`（信任代理头并启用 Secure Cookie）、
> 配置 `ADMIN_TOKEN`、并确保在 HTTPS 之后运行。
> 当前存储方案（单进程 JSON 文件）适合班级规模，不适合高并发。

---

## 六、常见问题

### `git push` 报错 `failed to push some refs`

通常是远程仓库已有内容（例如创建时勾选了 README）。解决：

```bash
git pull --rebase origin main
git push -u origin main
```

### 不小心把 `server/data/` 提交了

```bash
# 从 Git 中移除（保留本地文件）
git rm -r --cached server/data
git commit -m "chore: 移除不应提交的运行时数据"
git push
```

> 注意：历史提交中仍留有该文件。若要彻底清除需重写历史
> （`git filter-repo`）或删除仓库重建。若其中含真实用户数据，
> 建议同时**重置所有用户密码**。

### 想确认没有敏感文件被提交

```bash
git ls-files | findstr /i "data node_modules"
# 应无输出
```

或运行内置审计：

```bash
node tools/pre-publish-audit.js
```
