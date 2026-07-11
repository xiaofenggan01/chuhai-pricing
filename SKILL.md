---
name: chuhai-pricing
description: 跨境电商出海单品的利润决算与财务合规风控 Skill（品类通用）。输入商品图或名称 + 采购成本/尺寸/件数，按品类档案（潮玩/3C…，config 可扩）自动用 bl 找海外竞品在售公允价（遍历该品类竞品站抓站内搜、过滤预售/缺货/炒价），按「净利润=公允价−进价−体积重运费−3%抽成−2%退款拨备」算盈亏平衡点与净利润率，经四组财务校验（输入合法/公式自洽/价格可信/结果合理）硬拦截后，输出 Bento Box 财务合规红绿灯（通过/打退）+ 利润拆解表 + 汇率预警。Use when 用户要核出海商品利润、找海外竞品价、算跨境净利润/盈亏平衡点、做单品前置财报决算。依赖：阿里云百炼 bl（vision/text chat/search web）+ Node.js 18+。
---

# 跨境核价决策官

## 输入契约

```bash
node run.mjs --image <商品图> 或 --name <名称> \
  --cost <采购成本¥> \
  --size <LxWxH cm> \
  --size-type <pcs|carton|case> \   # 单品 / 整盒 / 整箱
  --pcs-set <整箱/盒件数> \
  [--category <品类档案>] \          # 潮玩盲盒 / 3C数码配件 …（缺省则 vision 识别+匹配，命中不了用默认档）
  [--special] [--ip <IP>] \          # --special：特殊物流形态（如毛绒/蓬松），套该品类特殊系数
  [--ref-price <竞品价USD>] \        # 已知可信竞品价则直接用
  [--allow-estimate]                 # 逃生阀：无可信价时放行「模型估算价」（仅演示，海报标注未验证）

# 批量：一张 CSV 核多款
node run.mjs --batch <file.csv> [--allow-estimate]
```

例（图输入）：`node run.mjs --image samples/labubu.jpeg --cost 69 --size 12x10x8 --size-type pcs --pcs-set 1`
例（名称输入）：`node run.mjs --name "Nanci" --ip "Finding Unicorn" --cost 45 --size 30x20x20 --size-type carton --pcs-set 12`

**CSV 列契约**（首行表头，中英列名皆可）：`name[,ip][,category],cost,size,size_type,pcs_set[,case_count][,special][,ref_price]`。必填 = name、cost、size、pcs_set。

## 执行（封装在 run.mjs）

1. `bl vision describe`（用图时）识别 商品名 / IP / 品类 / 是否毛绒。
2. 找海外公允价（**核心痛点·找竞品在售有效价**）：
   - 有 `--ref-price` → 直接用；
   - 否则 `bl search web` 偏置到 profile **预选大平台**（Amazon/eBay/AliExpress/Temu，已实测 bl 可达）逐个搜 → 按 url/snippet 过滤出该平台结果 → `bl text chat` 聚合解析**同款在售价**（排除 Preorder/缺货/二手/炒价、超出品类合理区间的整套价）；
   - 仍无 → 模型估算兜底（默认被 C 组拦截，除非 `--allow-estimate`）。
3. 财务核算（净利润公式，见下）。
4. **财务校验（四组·硬拦截）**：任一不过 → 非零退出、不出海报（严肃财务，容不得失误）。
   - **A 输入合法**：成本/尺寸/件数/汇率/费率/阈值/品类档案合法。
   - **B 公式自洽**：进价/综合成本/净利润重算比对 + **物流费独立复算**（从原始尺寸重推体积重+起送门槛+运费，堵 finance 分支 bug）。
   - **C 价格可信**：①来源白名单（web-*/user-ref-price），仅模型估算→拦；②**样本数门限**（web 价≥2 条相互印证）；③**离散度**（变异系数 cv>0.4 判高度离散，疑似炒价/异款混入）；④**同款确认**（bl 判搜索结果商品名 vs 输入名，防「搜 A 给 B」）；⑤**second opinion**（对中位价独立再判合理性，防单次提取失误）。
   - **D 结果合理**：公允价落在品类合理区间、净利率∈[−100%,100%]、毛利率≥净利率、成本占比≤100%。
   - 逃生：`--ref-price` 跳过 C2-C5（人工背书）；`--allow-estimate` 仅放行 C1 模型估算（演示用）。
5. 红线：净利润率 ≥20% 🟢 / <10% 🔴 / 中间 🟡。
6. 渲染 Bento Box 海报（含校验徽章行）→ `out/poster.html` 并自动打开。

## 固化工作流（Skill 的灵魂 · 用户发表格时按此走）

传统 AI Agent 核价靠临场搜索，结果飘忽、慢、不可复现。本 Skill 把流程**定死**——步骤、公式、费率、平台、校验全固定，可复现可审计。当用户直接发一张表（Excel/粘贴/图）要批量核价：

1. **规整成 CSV**：把用户的表整理为上面的列契约（列名可中可英），存成 `.csv`。
2. **预检**：`node run.mjs --batch file.csv`。
   - **退出码 3 = 缺数据** → 脚本会列出「第几行缺哪列」。**先把缺的字段逐条向用户要清楚**（如「第 4 行 BrokenRow 缺 cost，请补采购成本」），补齐后重跑，**绝不臆造数据**。
   - 退出码 0 = 全部核完。
3. **回传结果**：`out/batch/summary.html` 汇总表 + 每款 `out/batch/<slug>.html` 海报；单行校验没过的，summary 里标红失败原因，不影响其他行。
4. 单款临时核价用单 SKU 参数即可，同一套流程与校验。

> 关键：不临场发挥。找价平台是预选定死的、公式费率锁死、四组校验硬拦截——这才是「又快又准」的来源。

## 财务公式（净利润模型，全在 config.json 可调）

```
综合物流费 = 体积重(kg = L×W×H/5000) × 运费单价(¥/kg) ÷ 6.8    （含起送门槛 2.5kg 判断）
进价(USD)  = 成本价(¥) ÷ 6.8
平台抽成   = 海外公允价 × 3%       （行业标准·锁死，可在 config.fees 调）
退款拨备   = 海外公允价 × 2%       （行业标准·锁死，可在 config.fees 调）
净利润     = 海外公允价 − 进价 − 综合物流费 − 平台抽成 − 退款拨备
盈亏平衡价 = (进价 + 综合物流费) ÷ (1 − 抽成率 − 拨备率)   （净利润=0 时的公允价）
净利润率   = 净利润 ÷ 海外公允价
毛利率     = (海外公允价 − 进价 − 综合物流费) ÷ 海外公允价
红线       = 净利润率 ≥ 20% 绿 / < 10% 红
汇率敏感性 = fx 每跌 0.1 → 净利润率变化(pp)

> 物流系数（vol_divisor / 运费单价 / 冗余 / 起送门槛 / 特殊系数）与竞品站、价格合理区间，均按 `--category` 命中的**品类档案**读取；引擎本身不含任何品类词，加一个 profile 即可核新品类。
```

**费率锁死 + 透明展示**：平台抽成 3%（Stripe/PayPal 实际费率）、退款拨备 2%（零售业拨备标准）锁在 config，海报成本拆解透明列出、可审计；演示后评委问「改 2.5% 呢」，改 config 重跑即可。

## 输出（Bento Box 风格）

- 控制台：核价 JSON（商品 / 输入 / 公允价来源 / 净利润 / 净利润率 / 红线）。
- 海报 `out/poster.html`：
  - **左侧大红绿灯**：通过/打退 + 净利润率大字 + 结论
  - **右侧网格**：海外公允价/毛利率 · 综合成本 · 单件要素成本拆解 · 汇率风险预警

## 调参

- 全局：`fx_usd_to_cny`、`fees`（平台抽成/退款拨备）、`thresholds`（净利率红线）、`default_category`。
- **品类档案 `profiles.<品类>`**：`aliases`（识别匹配词）、`vision_hint`、`platforms`（预选取价大平台，须 bl 可达）、`price_sane_usd`（合理区间，D 组校验用）、`logistics`（vol_divisor/运费单价/冗余/起送门槛）、`unit_coeff`（special 特殊系数 + 标签）。
- **加新品类**：复制一份 profile、改系数与预选平台即可，引擎零改动（3C/服装/家居…）。