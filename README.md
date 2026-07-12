# 跨境核价决策官 · 出海单品前置财报决算官

> 把滞后的财务记账，变成一键前置的财务风控。

跨境电商出海选品，隐藏着最大的**财务黑洞——单品利润测算严重滞后**。业务员每核一款都要 15–20 分钟：找海外竞品公允价、剔除缺货与炒价、再揉进进价、体积重运费、平台抽成、退款拨备金，算清**盈亏平衡点**。

这个 Skill 把整套经验流程封装成一条命令：**传商品图或名称 → 秒出单品利润拆解 + 财务合规红绿灯**。**品类通用**——潮玩、3C 等品类各有一份「档案」，加一个档案即可核新品类，引擎零改动。

> 一个 Skill，顶半个管理后台。

### 严肃财务 · 四组校验硬拦截

单品核价是要拿去做决策的严肃财务，容不得失误。核算后强制过 **四组校验**，任一不过 → **非零退出、不出海报**：

- **A 输入合法**：成本/尺寸/件数/汇率/费率/阈值/品类档案是否合法。
- **B 公式自洽**：综合成本=各项加总、净利润=公允价−成本、体积重非负（重算比对）。
- **C 价格可信**：零售价必须来自真实竞品在售价或 `--ref-price`；仅模型估算 → 拦截（除非显式 `--allow-estimate` 放行，海报标「估算·未验证」）。
- **D 结果合理**：公允价落在品类合理区间、净利率∈[−100%,100%]、毛利率≥净利率、成本占比≤100%。

---

## 核心链路

```
输入：商品图 或 --name + 成本¥ + 尺寸 + 口径 + 件数 + [--category] + [竞品价?]
  │
  ① bl vision describe（Qwen-VL）→ 识别 商品名 / IP / 品类 / 特殊物流形态
  │  → 按 --category 或识别结果匹配【品类档案】（潮玩/3C…），装载该品类的竞品站/价格区间/物流系数
  │
  ② 找海外公允价【核心痛点】（预选大平台 + 合理区间来自品类档案）
     · bl search web 偏置到预选大平台（Amazon/eBay/AliExpress/Temu，已实测 bl 可达）
     · 按 url/snippet 过滤出各平台结果 → bl text chat 聚合解析【同款在售价】
     · 排除 预售 / 缺货 / 二手 / 超区间炒价 / 整套价
     · 仍无 → 模型估算兜底（默认被 C 组拦截，除非 --allow-estimate）
  │
  ③ 单品利润决算（公式确定性，全在 config.json 可调）
  │
  ④ 四组财务校验（A输入/B公式/C可信/D合理）→ 任一不过则 exit 2、不出海报
  │
  ⑤ 财务合规风控：净利润率 ≥ 20% 🟢 / < 10% 🔴 / 中间 🟡
  │
  ⑥ 渲染 Bento Box 海报 → out/poster.html（校验徽章 + 红绿灯 + 利润拆解 + 盈亏平衡价 + 汇率预警）
```

## 单品利润拆解公式

```
综合物流费 = 体积重(kg = L×W×H/5000) × 运费单价(¥/kg) ÷ 6.8    （含起送门槛 2.5kg 判断）
进价(USD)  = 成本价(¥) ÷ 6.8
平台抽成   = 海外公允价 × 3%       （行业标准·锁死）
退款拨备   = 海外公允价 × 2%       （行业标准·锁死）
净利润     = 海外公允价 − 进价 − 综合物流费 − 平台抽成 − 退款拨备
净利润率   = 净利润 ÷ 海外公允价
盈亏平衡点 = 让净利润 = 0 的公允价
红线       = 净利润率 ≥ 20% 绿 / < 10% 红
```

**隐形成本锁死 + 透明展示**：抽成 3%（Stripe/PayPal 实际费率）、退款拨备 2%（零售业拨备标准）锁在 `config.json`，海报成本拆解透明列出、可审计。

---

## 快速开始

依赖：[阿里云百炼 CLI `bl`](https://github.com/modelstudioai/cli)（已登录）、Node.js 18+。

```bash
cd chuhai-pricing

# A) 业务员只给图（vision 识别）
node run.mjs --image samples/skullpanda.png \
  --cost 59 --size 12x10x8 --size-type pcs --pcs-set 1

# B) 直接给名称（供应商常给名称，更准）
node run.mjs --name "Nanci" --ip "Finding Unicorn" \
  --cost 45 --size 30x20x20 --size-type carton --pcs-set 12

# C) 已知竞品价（跳过联网）
node run.mjs --name "Labubu" --cost 69 \
  --size 12x10x8 --size-type pcs --pcs-set 1 --ref-price 24.99
```

海报自动弹出：`out/poster.html`。

### 输入参数

| 参数 | 说明 |
|---|---|
| `--image` 或 `--name` | 商品图路径，或直接给名称（二选一） |
| `--cost` | 采购成本价 ¥ |
| `--size` | 长×宽×高 cm，如 `30x20x20` |
| `--size-type` | `pcs`(单品) / `carton`(整盒) / `case`(整箱) |
| `--pcs-set` | 整盒/整箱内件数 |
| `--category` | 可选：品类档案（`潮玩盲盒` / `3C数码配件` …）。缺省则 vision 识别+匹配；**显式传错则硬拦截**，不静默回落 |
| `--special` | 特殊物流形态（如毛绒/蓬松），套该品类特殊系数；不传则用 vision 判断 |
| `--ref-price` | 可选：竞品参考价 USD；不给则联网找公允价 |
| `--allow-estimate` | 逃生阀：无可信价时放行「模型估算价」（仅演示，海报标注未验证） |
| `--batch <file.csv>` | 批量：一张 CSV 核多款，产出逐单海报 + 汇总页 |

### 批量核价（发一张表过来）

```bash
node run.mjs --batch skus.csv
```

CSV 首行表头（中英列名皆可），列契约：

```
name,ip,category,cost,size,size_type,pcs_set,ref_price
Nanci,Finding Unicorn,潮玩盲盒,45,30x20x20,carton,12,19.99
Wireless Earbuds,,3C数码配件,60,8x6x3,pcs,1,29.99
```

必填 = `name`、`cost`、`size`、`pcs_set`。**缺数据先问**：任一行缺必填 → 打印「第几行缺哪列」并 `exit 3`，**不核价**——补齐后重跑（绝不臆造）。产出：`out/batch/summary.html` 汇总表 + 每款一张 Bento Box 海报。

> **固化流程 vs 传统临场搜索**：传统 AI Agent 每次现搜、结果飘忽、慢且不可复现；本 Skill 把「找价平台 / 公式 / 费率 / 四组校验」全定死，同一输入永远同一结果，可审计、可批量、可交接。

---

## 目录结构

```
chuhai-pricing/
├── SKILL.md          # Skill 主体：触发词 + 输入契约 + 公式 + 红线
├── run.mjs           # 编排脚本：vision → 找价 → 决算 → Bento Box 海报
├── config.json       # 全局费率/红线 + profiles 品类档案（潮玩/3C，可扩）
├── poster.html       # Bento Box 海报模板（校验徽章 + 红绿灯 + 利润拆解 + 汇率预警）
├── samples/          # 演示用商品图
└── ppt/
    └── index.html    # 路演 PPT（电子杂志风 · 靛蓝瓷，浏览器打开即演）
```

## 技术栈

- **阿里云百炼 `bl`**（全程）：`vision describe`（识图）、`text chat`（解析在售价/决算）、`search web`（MCP 联网兜底）
- **Node.js fetch**：直接抓竞品站站内搜索页（绕过搜索摘要，拿结构化在售数据）
- **纯 HTML/CSS**：Bento Box 海报 + 路演 PPT（无构建依赖）

## 真实案例

### 取价决算（核价）

| SKU | 结果 |
|---|---|
| silicone phone case（3C·真取价） | bl 搜 Amazon/AliExpress 命中 3 条在售，中位 **$7.37** · 净利率 71.7% 🟢 |
| Nanci（Finding Unicorn·潮玩） | 净利率 **50.6%** · 单件净利 $10.11 · 🟢 绿灯 |
| Sony WH-1000XM5（超区间） | $348 超 3C 档 [3,120] → **D1 硬拦截**、不出海报 ✅ |

### 反推测试（shopvidi 真实上架 SKU · 已知零售 → 最高进价）

> 数据源：us.shopvidi.com/shop 真实在售商品 + 公开零售价；尺寸用端盒估值（25×18×12cm / 12 件）。反推是纯本地计算，不联网、可复现。

`node run.mjs --batch shopvidi.csv --reverse`

| SKU | 站点零售 | **绿线最高进价 (≥20% 净利率)** | 红线 (≥10%) | 盈亏平衡 |
|---|---|---|---|---|
| Link Click 棋子盲盒 | $7.49 (¥51) | **¥23.65** | ¥28.74 | ¥33.83 |
| Blue Lock 拼图盲盒 | $10.49 (¥71) | **¥38.95** | ¥46.08 | ¥53.21 |
| MIFFY Picnic 盲盒 | $17.49 (¥119) | **¥74.65** | ¥86.54 | ¥98.43 |
| BRUCREO 初音未来 Figure | $20.49 (¥139) | **¥89.95** | ¥103.88 | ¥117.81 |
| Bonnie 1/6 BJD 盲盒 | $58.49 (¥398) | **¥283.75** | ¥323.52 | ¥363.29 |

采购只要付得比「绿线」低，就稳过 20% 净利率——这是和供应商谈判的硬底牌。

---

## 调参 / 扩品类

`config.json` 分两层：

- **全局**：`fx_usd_to_cny`、`fees`（平台抽成/退款拨备）、`thresholds`（净利率红线）、`default_category`。
- **品类档案 `profiles.<品类>`**：`aliases`（识别匹配词）、`vision_hint`、`competitor_sites`、`price_sane_usd`（合理区间，D 组校验用）、`logistics`（vol_divisor/运费单价/冗余/起送门槛）、`unit_coeff`（special 特殊系数+标签）。

**扩新品类**：复制一份 profile、改系数与竞品站即可，引擎零改动（服装 / 家居 / 家电…）。

## License

MIT
