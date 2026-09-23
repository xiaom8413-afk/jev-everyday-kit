# Feishu Triage · 多维表格反馈分诊

适合产品反馈池、内部 IT 请求、需求收集与咨询工单。支持本地工作台和命令行，无需公网 Webhook，不发送群消息。

## 准备表格与应用

1. 在[飞书开放平台](https://open.feishu.cn/app)创建企业自建应用，获取 App ID / Secret，按组织要求发布或启用。
2. 申请读取多维表格记录、读取字段、更新记录的权限。如果要自动创建输出列，还需字段创建权限。
3. 把应用添加为目标多维表格协作者。应用 API 权限和表格数据权限都要具备。开启高级权限的表格还可能需要可管理权限。
4. 创建一个多行文本输入列，默认叫“反馈内容”。四个输出列同样使用多行文本：

| 字段 | 内容 |
| --- | --- |
| Jev分类 | 故障反馈 / 功能需求 / 账号权限 / 订单账单 / 使用咨询 / 其他 / 待确认 |
| Jev优先级 | 紧急 / 常规 / 低 / 待确认 |
| Jev状态 | 已分类 / 待人工确认 / 人工已确认 |
| Jev把握 | 两个问题 confidence 与选中概率的最小值，显示为百分比 |

工作台可以检查字段，并列出缺少的输出列，确认后创建；不会改造已有的非文本字段。也可以使用 `feishu setup --config ...` 创建缺少的输出列，命令本身即表示执行创建。

官方权限与接口说明：[查询记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search)、[批量读取](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/batch_get)、[更新记录](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/batch_update)、[字段](https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/list)。

## 工作台流程

运行 `node dist/jev.mjs serve`，方便时访问本机地址。

在连接设置填写 TypeSafe Key、飞书 App ID / Secret。进入飞书分诊，粘贴 `/base/` 表格链接自动填写 Token / Table / View，或手动填写。App Token 是表格的标识，**不是 App ID，也不是 tenant_access_token**。Wiki 节点 Token 不能直接替代 Base Token。

生成计划后可以搜索、只看待确认项、取消选择某行，或手动修正类别和优先级。模型把握不足的记录写入“待确认”，不会强行作为确定分类；手动修正后标记为“人工已确认”。

点击回填时会列明条数和目标列供确认。已经有回填回执的计划会锁定，防止之后的人工编辑使回执失效。需要新的判断时，重新生成计划。

## 命令行流程

```bash
cp examples/feishu.config.json feishu.local.json
# 在本地填写 appToken、tableId、列名；可选 viewId、threshold
```

通过 `.env` 或环境变量提供 `TYPESAFE_API_KEY`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。

```bash
node dist/jev.mjs feishu check --config feishu.local.json
node dist/jev.mjs feishu setup --config feishu.local.json
node dist/jev.mjs feishu plan --config feishu.local.json --limit 100 --out output/feishu
```

检查 `plan.json` 中 `preview`、`fields` 和 `excluded`。随后主动执行：

```bash
node dist/jev.mjs feishu apply --plan output/feishu/plan.json
```

回执写入 `plan.json.receipt.json`。遇到部分失败时，命令返回非零退出码；可以重跑同一命令。已有内容与计划相同的行不会重复写入，之前成功写入的归属记录会保留。已有回执时不能修改计划后直接重试。

撤销：

```bash
node dist/jev.mjs feishu rollback \
  --plan output/feishu/plan.json \
  --receipt output/feishu/plan.json.receipt.json
```

撤销只处理回执证明由本次成功写入的行。输入或输出已被改动的记录会跳过；已经恢复的行可以被识别，允许继续未完成的撤销。

## 冲突、范围与恢复

- 在飞书服务端筛选“输入非空 + 四个输出列均为空”。`--limit` 计数的是待处理记录，默认 100、最多 5,000，不会再卡在前面的已处理行。
- 可以指定 `viewId` 限定视图，支持分页。达到上限时会标记，下一轮回填后可继续处理剩余行。
- 回填前重新读取输入与输出，检测内容哈希与人工编辑，只更新四个指定列。
- 每条操作后保存回执。中断、网络异常和部分失败可以通过同一计划恢复。大量记录会逐条检查和回填，速度依赖飞书 API。
- 飞书 API 没有这里可用的条件更新机制；读取和写入之间仍有短暂竞争窗口。批处理期间避免多人同时编辑目标输出列。
- 对结果不明确的写入不自动重发；下一次重跑时先读取实际状态。没有成功回执证明的记录不会被自动撤销。
- 单条推理最多发送前 4,000 字符，每批 6 条以限制请求体大小。计划预览最多 800 字符，完整原文的哈希用于检测变化。
- 不读取附件、图片、关联表或人员字段。五个配置列均需是多行文本。
- 演示计划不能回填。紧急程度是辅助判断，不能替代团队事故响应流程。
