## HN LZ Auto script

这个仓库主要包含一个 Tampermonkey 脚本：[user_script.js](user_script.js)，用于在轮转/技能录入页面里自动打开“添加”弹窗并自动填写（科室/编号/日期/病历类型/主要诊断/技能/备注），支持批量录入。

注意：本仓库默认不会提交本地数据文件（如 `records*.md`、`records*.json`）和根目录图片；规则已写入 .gitignore。

## 使用方法（Tampermonkey）

1) 浏览器安装 Tampermonkey 扩展

2) 新建脚本，把 [user_script.js](user_script.js) 的内容完整粘贴进去并保存

3) 打开系统页面（脚本头部 `@match` 指定的地址），右上角会出现 `LZ Auto` 按钮

4) 点击 `LZ Auto` 打开面板：

- `Scan`：重新识别当前页面/iframe 上下文
- `Run One`：读取文本框中的 JSON，录入第一条
- `Start Batch`：读取文本框中的 JSON，逐条批量录入
- `Stop`：停止批量

### 输入 JSON 格式

面板的文本框支持两种格式：

- 数组：`[ { ... }, { ... } ]`
- 包裹对象：`{ "surgeries": [ { ... } ] }`

每条记录常用字段：

- `hospitalNumber` / `inpatient_no` / `inpatientNo` / `recordNo`：病历号（脚本会自动择一）
- `operateDate`：操作日期（可选；不传则用 `CFG.DATE_FALLBACK`）
- `remark` / `remarks`：备注（可选；配合 `CFG.REMARK`）

## 配置项（CFG）

配置在 [user_script.js](user_script.js) 顶部的 `const CFG = { ... }`。

### 基础

- `TARGET_DEPT_NAME`：轮转科室下拉里要选择的目标文本
- `DATE_FALLBACK`：当输入数据没有 `operateDate` 时使用的默认日期
- `STEP_DELAY`：通用步骤间延迟（毫秒）
- `WAIT_TIMEOUT`：等待控件出现/回填的超时时间（毫秒）

### 主要诊断

- `PICK_MAIN_DIAG_COUNT`：保留字段（当前脚本选择 1 个主要诊断）
- `PRIORITIZE_UNFINISHED`：是否优先选“未完成”的条目（见下文策略说明）

### 技能操作

- `PICK_SKILL_COUNT`：限制最终点击/保存的技能数量
	- `> 0`：生效（若命中很多技能，会按策略选出 `PICK_SKILL_COUNT` 个）
	- `0` 或 `-1`：不生效（不限制数量）
- `SKILL_FALLBACK_PICK_COUNT`：当所有 `SKILL_COMBOS` 都不达标时，fallback 选择的技能数量
- `SKILL_COMBOS`：技能组合匹配规则（会在每次打开技能下拉时随机打乱组合顺序再尝试）

`SKILL_COMBOS` 结构：

- `name`：组合名（用于日志）
- `minMatch`：至少命中多少个 `items` 才认为该组合可用
- `items`：二维数组，每一项是“关键词列表”（同义词/别名）

匹配逻辑要点：

- 对每个 item，会优先使用第一个关键词做“强匹配”（更精确）；找不到再用其它关键词做“弱匹配”
- 开启 `PRIORITIZE_UNFINISHED` 后，当一个关键词能匹配多个技能，会优先选择未达标且“差距(要求数-完成数)最大”的条目

### 未完成优先策略（PRIORITIZE_UNFINISHED）

开启后，脚本会从选项文字中解析类似 `要求数:50,完成数:7` 的提示，并优先选择 `完成数 < 要求数` 的诊断/技能。

如果某些条目不含该提示，脚本会自动回退到普通选择逻辑。

### 备注（可选）

- `REMARK.enabled`：是否启用备注自动填写
- `REMARK.preferInputRemark`：优先使用输入 JSON 里的 `remark/remarks`
- `REMARK.separator`：拼接字段的分隔符
- `REMARK.fallback`：没有可拼接字段时的兜底备注
- `REMARK.fields` / `REMARK.labels`：从输入 JSON 的 `raw` 中抽取字段并拼接

## Python 工具：从 records.md 提取表格到 JSON

脚本：extract_records_md_to_operate_json.py

功能：
- 从 records.md 的 Markdown 表格提取到 JSON（结构对齐 records_surgery_with_operate_date.json）
- 为每条手术记录生成随机 operate_date（默认范围：2025-04-01 ~ 2025-08-31）
- 支持同一个文件里存在多段表格时，合并提取所有手术记录

### 1) 最常用（生成 JSON 文件）

在项目目录运行：

```powershell
c:/Users/48969/Documents/WorkSpace/mengmeng/skill_record/.venv/Scripts/python.exe extract_records_md_to_operate_json.py --input records.md --output records_surgery_with_operate_date.json --pretty --seed 42
```

说明：
- --seed 42：让随机日期可复现（同一份 records.md 多次运行会得到相同的 operate_date 分配）。不需要复现就可以不加。
- --pretty：让 JSON 更好读（缩进格式化）。

### 2) 修改随机日期范围（2025 年 4~8 月）

```powershell
c:/Users/48969/Documents/WorkSpace/mengmeng/skill_record/.venv/Scripts/python.exe extract_records_md_to_operate_json.py --input records.md --output records_surgery_with_operate_date.json --pretty --operate-start 2025-04-01 --operate-end 2025-08-31
```

### 3) 参数速查

- --input / -i：输入 Markdown（默认 records.md）
- --output / -o：输出 JSON（默认 <input>_surgery_with_operate_date.json）
- --operate-start：随机 operate_date 开始日期（YYYY-MM-DD）
- --operate-end：随机 operate_date 结束日期（YYYY-MM-DD）
- --seed：随机种子（可选；用于复现）
- --pretty：格式化输出（可选）

### 4) 结果在哪里

默认会生成：records_surgery_with_operate_date.json

