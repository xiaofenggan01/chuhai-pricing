# 跨境核价决策官 · 出海单品前置财报决算官

> 把滞后的财务记账，变成一键前置的财务风控。

潮玩盲盒出海选品，隐藏着最大的**财务黑洞——单品利润测算严重滞后**。业务员每核一款都要 15–20 分钟：找海外竞品公允价、剔除缺货与炒价、再揉进进价、体积重运费、平台抽成、退款拨备金，算清**盈亏平衡点**。

这个 Skill 把整套经验流程封装成一条命令：**传商品图或名称 → 秒出单品利润拆解 + 财务合规红绿灯**。

> 一个 Skill，顶半个管理后台。

---

## 核心链路

```
输入：商品图 或 --name + 成本¥ + 尺寸 + 口径 + pcs-set + 毛绒? + [竞品价?]
  │
  ① bl vision describe（Qwen-VL）→ 识别 商品名 / IP / 品类 / 是否毛绒
  │
  ② 找海外公允价【核心痛点】
     · 遍历 SOP 竞品站（kikagoods→ttmart→tesolife→whoopea…）fetch 站内搜索页
     · bl text chat 解析【同款在售价】——排除 预售 / 缺货 / Sold out / 炒价($60+)
     · 竞品站无同款 → bl search web 搜官网/Amazon（需开 MCP）
     · 仍无 → 模型估算兜底（海报标注来源档位）
  │
  ③ 单品利润决算（公式确定性，全在 config.json 可调）
  │
  ④ 财务合规风控：净利润率 ≥ 20% 🟢 / < 10% 🔴 / 中间 🟡
  │
  ⑤ 渲染 Bento Box 海报 → out/poster.html（红绿灯 + 利润拆解表 + 汇率预警）
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
| `--size-type` | `pcs`(单品) / `carton`(端盒) / `case`(箱) |
| `--pcs-set` | 端盒中 PCS 数量 |
| `--plushie` | 毛绒则加此 flag（系数 1.2）；不传则用 vision 判断 |
| `--ref-price` | 可选：竞品参考价 USD；不给则联网找公允价 |

---

## 目录结构

```
chuhai-pricing/
├── SKILL.md          # Skill 主体：触发词 + 输入契约 + 公式 + 红线
├── run.mjs           # 编排脚本：vision → 找价 → 决算 → Bento Box 海报
├── config.json       # 财务系数（汇率/运费/抽成/拨备/红线）+ 竞品站 + 基线库
├── poster.html       # Bento Box 海报模板（红绿灯 + 利润拆解 + 汇率预警）
├── samples/          # 演示用商品图
└── ppt/
    └── index.html    # 路演 PPT（电子杂志风 · 靛蓝瓷，浏览器打开即演）
```

## 技术栈

- **阿里云百炼 `bl`**（全程）：`vision describe`（识图）、`text chat`（解析在售价/决算）、`search web`（MCP 联网兜底）
- **Node.js fetch**：直接抓竞品站站内搜索页（绕过搜索摘要，拿结构化在售数据）
- **纯 HTML/CSS**：Bento Box 海报 + 路演 PPT（无构建依赖）

## 真实案例

| SKU | 结果 |
|---|---|
| Nanci（Finding Unicorn） | kikagoods 命中 5 条在售，中位 **$19.99** |
| Labubu（图端到端） | 净利润率 **58.6%** · 单件净利 $20 · 🟢 绿灯 |

---

## 调参

改 `config.json`：汇率、运费单价、毛绒系数、冗余、起送门槛、平台抽成 / 退款拨备费率、净利润率红线、竞品站点、基线库。

引擎通用——换系数即可核其他品类（3C / 服装 / 家居）或其他渠道。

## License

MIT
