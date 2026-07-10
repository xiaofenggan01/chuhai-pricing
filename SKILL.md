---
name: chuhai-pricing
description: 跨境电商出海单品的利润决算与财务合规风控 Skill。输入商品图或名称 + 采购成本/尺寸/pcs数，自动用 bl 找海外竞品在售公允价（遍历 kikagoods/ttmart 等站抓站内搜、过滤预售/缺货/炒价），按「净利润=公允价−进价−体积重运费−3%抽成−2%退款拨备」算盈亏平衡点与净利润率，输出 Bento Box 财务合规红绿灯（通过/打退）+ 利润拆解表 + 汇率预警。Use when 用户要核出海商品利润、找海外竞品价、算跨境净利润/盈亏平衡点、做单品前置财报决算。依赖：阿里云百炼 bl（vision/text chat/search web）+ Node.js 18+。
---

# 跨境核价决策官

## 输入契约

```bash
node run.mjs --image <商品图> 或 --name <名称> \
  --cost <采购成本¥> \
  --size <LxWxH cm> \
  --size-type <pcs|carton|case> \   # 单品 / 端盒 / 箱
  --pcs-set <端盒中PCS数> \
  [--plushie] [--ip <IP>] [--ref-price <竞品价USD>]
```

例（图输入）：`node run.mjs --image samples/labubu.jpeg --cost 69 --size 12x10x8 --size-type pcs --pcs-set 1`
例（名称输入）：`node run.mjs --name "Nanci" --ip "Finding Unicorn" --cost 45 --size 30x20x20 --size-type carton --pcs-set 12`

## 执行（封装在 run.mjs）

1. `bl vision describe`（用图时）识别 商品名 / IP / 品类 / 是否毛绒。
2. 找海外公允价（**核心痛点·找竞品在售有效价**）：
   - 有 `--ref-price` → 直接用；
   - 否则遍历 SOP 竞品站（kikagoods→ttmart→tesolife→whoopea…）fetch 站内搜索页 → `bl text chat` 解析**同款在售价**（排除 Preorder/缺货/Sold out/炒价 $60+）；
   - 竞品站无同款（多为旗舰 IP）→ `bl search web` 搜官网/Amazon + 炒价过滤；
   - 仍无 → 模型估算兜底（海报标注）。
3. 财务核算（净利润公式，见下）。
4. 红线：净利润率 ≥20% 🟢 / <10% 🔴 / 中间 🟡。
5. 渲染 Bento Box 海报 → `out/poster.html` 并自动打开。

## 财务公式（净利润模型，全在 config.json 可调）

```
综合物流费 = 体积重(kg = L×W×H/5000) × 运费单价(¥/kg) ÷ 6.8    （含起送门槛 2.5kg 判断）
进价(USD)  = 成本价(¥) ÷ 6.8
平台抽成   = 海外公允价 × 3%       （行业标准·锁死）
退款拨备   = 海外公允价 × 2%       （行业标准·锁死）
净利润     = 海外公允价 − 进价 − 综合物流费 − 平台抽成 − 退款拨备
盈亏平衡点 = 让净利润 = 0 时的公允价
净利润率   = 净利润 ÷ 海外公允价
毛利率     = (海外公允价 − 进价 − 综合物流费) ÷ 海外公允价
红线       = 净利润率 ≥ 20% 绿 / < 10% 红
汇率敏感性 = fx 每跌 0.1 → 净利润率变化(pp)
```

**费率锁死 + 透明展示**：平台抽成 3%（Stripe/PayPal 实际费率）、退款拨备 2%（零售业拨备标准）锁在 config，海报成本拆解透明列出、可审计；演示后评委问「改 2.5% 呢」，改 config 重跑即可。

## 输出（Bento Box 风格）

- 控制台：核价 JSON（商品 / 输入 / 公允价来源 / 净利润 / 净利润率 / 红线）。
- 海报 `out/poster.html`：
  - **左侧大红绿灯**：通过/打退 + 净利润率大字 + 结论
  - **右侧网格**：海外公允价/毛利率 · 综合成本 · 单件要素成本拆解 · 汇率风险预警

## 调参

`config.json`：汇率 6.8、运费单价、毛绒系数、冗余、起送门槛、平台抽成/退款拨备费率、净利润率红线、竞品站点、基线库。引擎通用，换系数可核其他品类。