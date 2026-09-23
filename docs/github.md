# Star Atlas · GitHub 工具收藏分类

把 Star 或仓库清单整理成可搜索、可修正、可离线打开的工具箱。

## 工作台使用

运行 `node dist/jev.mjs serve`，由你在方便时访问本机地址。在连接设置填 TypeSafe Key；GitHub Token 可选，匿名额度不足时需要填写。

选择用户名的公开 Star 或指定仓库清单，设置数量和阈值后开始。完成结果支持：

- 搜索名称、简介、topics、个人备注。
- 按用途、产品形态、语言、归档状态筛选。
- 按 Star 数、名称或待确认优先排序。
- 手动调整类别和形态，添加备注；标明“人工确认”。
- 下载 Markdown、完整 JSON 或自包含离线 HTML。

离线 HTML 无需服务器，保留搜索和筛选，不请求外部资源。点击仓库链接时才前往 GitHub。

## 命令行

```bash
node dist/jev.mjs github --user YOUR_GITHUB_USERNAME --limit 100
node dist/jev.mjs github --repos examples/repos.txt --out output/my-tools
node dist/jev.mjs github --user YOUR_GITHUB_USERNAME --refresh
```

每行一个 `owner/repo` 或完整仓库 URL。默认产物在 `output/github/`：`catalog.md`、`catalog.json`、`catalog.html`。

每批 10 个仓库，一次请求中分别判断用途和产品形态。默认读取 100 个，支持至 10,000；达到上限时明确标记。只读取公开仓库，私有仓库始终过滤。不读源码或 README，不修改收藏、提交或推送。

目录是导出的工具箱，不会写入 GitHub 原生 Star Lists。用户隐藏资料或 Token 没有对应权限时，API 可能返回空列表或错误。

## 缓存与人工修正

`.jev-cache.json` 按模型、分类方案、仓库名称、简介、topics 和语言建立缓存。Star 数变化不会重新推理；分类依据变化会重新判断。每批完成后保存，所以之后的批次失败或取消也可以复用进度。

`--refresh` 忽略模型缓存。人工修正始终优先保留；要恢复纯模型结果，可以在新的输出目录重新运行。工作台会为同一来源保存独立目录，以免不同收藏列表混在一起。

只删除 `.jev-cache.json` 可以清除模型缓存；人工修正和备注保存在 `catalog.json` 与 `.manual-overrides.json` 中，仍然保留。演示修正使用独立的 `.manual-demo.json`，不会写入真实模型缓存或人工修正文件。

重复使用同一输出目录会更新导出文件。需要历史快照时使用不同的 `--out`；工作台会保存每个任务的结果供历史查看。

## 类别

用途：AI 与 Agent、Web 开发、开发工具、数据与数据库、部署与运维、自动化、效率与知识管理、设计与多媒体、安全与隐私、学习资源、待确认。

形态：应用、CLI、库 / 框架、服务、资源、待确认。

简介来自 GitHub 原文，不生成没有依据的功能描述。低把握项归入“待确认”；完整概率分布与模型原始建议保留在 JSON 中。

## GitHub Action

1. 将完整的 `dist/github-action/` 目录复制到目标仓库的 `.github/actions/jev-star-atlas/`，包括 `index.cjs`、`action.yml` 和第三方许可证。
2. 添加仓库 Secret：`TYPESAFE_API_KEY`。
3. 将 `examples/github-stars.workflow.yml` 复制为 `.github/workflows/jev-stars.yml` 并提交。
4. 在 Actions 中手动输入用户名运行。Job Summary 有 Markdown 目录，Artifact 包含全部三种导出。

输入参数：`username`、`typesafe-api-key`、可选 `github-token`、`limit`、`model`、`threshold`、`refresh`、`output-directory`。Action 使用 Node.js 24，自托管 Runner 需支持该运行时。

复用跨次运行缓存时，可在工作流中使用官方 `actions/cache` 恢复和保存 `jev-catalog/.jev-cache.json`。示例工作流保持手动运行，不创建定时任务，不自动提交、推送或公开部署目录。
