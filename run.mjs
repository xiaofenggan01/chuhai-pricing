#!/usr/bin/env node
// 跨境核价决策官 — 跨境电商出海净利润核价（品类档案 Profiles + 财务校验硬拦截）
// 净利润 = 海外公允价 − 进价 − 综合物流费 − 平台抽成 − 退款拨备
// 用法见 SKILL.md

import { execFile, exec } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const BL = "bl";

// ---------- args ----------
function parseArgs(argv) {
  const a = { size_type: "carton", plushie: false, allow_estimate: false };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case "--image": a.image = argv[++i]; break;
      case "--name": a.name = argv[++i]; break;
      case "--ip": a.ip = argv[++i]; break;
      case "--category": a.category = argv[++i]; break;
      case "--cost": case "--cost-cny": a.cost = Number(argv[++i]); break;
      case "--size": a.size = argv[++i]; break;
      case "--size-type": a.size_type = argv[++i]; break;
      case "--pcs-set": a.pcs_set = Number(argv[++i]); break;
      case "--case-count": a.case_count = Number(argv[++i]); break;
      case "--plushie": case "--special": a.plushie = true; break;
      case "--ref-price": a.ref_price = Number(argv[++i]); break;
      case "--allow-estimate": a.allow_estimate = true; break;
      case "--batch": a.batch = argv[++i]; break;
    }
  }
  return a;
}

// ---------- bl runner ----------
function runBl(cmdArgs, { timeout = 90 } = {}) {
  const attempt = (t) => new Promise((resolve, reject) => {
    execFile(BL, [...cmdArgs, "--output", "json", "--timeout", String(t)], { maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`bl failed: ${err.message}\n${stderr}`));
      const out = stdout.trim();
      try { resolve(JSON.parse(out)); } catch { resolve({ __text: out }); }
    });
  });
  return attempt(timeout).catch(() => { console.log("  ⚠️ 超时/出错，重试中…"); return attempt(timeout + 30); });
}

function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = fence ? fence[1] : text;
  const lo = s.indexOf("{"), hi = s.lastIndexOf("}");
  if (lo === -1 || hi === -1) return null;
  try { return JSON.parse(s.slice(lo, hi + 1)); } catch { return null; }
}

const chatContent = (res) => {
  if (!res) return "";
  if (typeof res === "string") return res;
  if (res.choices?.[0]?.message?.content) return res.choices[0].message.content;
  if (res.__text) return res.__text;
  if (typeof res === "object") return JSON.stringify(res);
  return String(res);
};

// ---------- profile 选档 ----------
// 纯匹配：命中返回 profile 名，否则 null（不做默认回落）
function matchProfile(cfg, cat) {
  if (!cat) return null;
  const low = String(cat).toLowerCase();
  for (const n of Object.keys(cfg.profiles || {})) {
    if (n.toLowerCase() === low) return n;
    const p = cfg.profiles[n];
    if ((p.aliases || []).some((a) => low.includes(a.toLowerCase()) || a.toLowerCase().includes(low))) return n;
  }
  return null;
}

// ---------- vision ----------
async function recognize(image, hint) {
  const prompt = `识别图中的${hint || "商品"}。只返回JSON：name(商品名),ip(品牌或IP),category(品类),is_special(是否属于蓬松/毛绒/大体积等特殊物流形态,true/false)。不要其他文字。`;
  const res = await runBl(["vision", "describe", "--image", image, "--prompt", prompt]);
  const j = extractJson(chatContent(res));
  return j ?? { name: "未知商品", ip: "", category: "", is_special: false };
}

// ---------- 取价 ----------
async function estimateRetail(info, prof) {
  const [lo, hi] = prof.price_sane_usd;
  const msg = `商品：${info.name}（IP：${info.ip || "未知"}，品类：${info.category || prof.vision_hint}）。给该商品或同类商品在海外零售站点的常见零售价(USD)，正常区间约$${lo}-${hi}。只返回JSON：{"retail_usd_low":数字,"retail_usd_high":数字,"retail_usd":建议中位价}。不要其他文字。`;
  const res = await runBl(["text", "chat", "--message", msg]);
  const j = extractJson(chatContent(res));
  const mid = j?.retail_usd ?? (j && j.retail_usd_low != null && j.retail_usd_high != null ? (j.retail_usd_low + j.retail_usd_high) / 2 : null);
  return { retail_usd: mid ?? (lo + hi) / 2, source: mid != null ? "model-estimate" : "model-fallback", range: j && j.retail_usd_low != null ? [j.retail_usd_low, j.retail_usd_high] : null };
}

async function fetchUrl(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (Macintosh) chuhai-pricing/1.0" } });
    if (!r.ok) return "";
    return await r.text();
  } catch { return ""; }
  finally { clearTimeout(t); }
}

function stripHtml(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

// 【核心痛点】图/名称 → 竞品在售有效价：遍历 profile 竞品站抓站内搜 → 解析同款在售价（排除预售/缺货/炒价）
async function searchCompetitorPrices(info, prof) {
  const raw = `${info.name || ""} ${info.ip || ""}`.trim() || info.category || prof.vision_hint;
  const kw = raw.split(/\s+/).slice(0, 3).join(" ");
  const [lo, hi] = prof.price_sane_usd;
  for (const site of prof.competitor_sites || []) {
    const url = `https://${site}/search?q=${encodeURIComponent(kw)}`;
    console.log(`  → 抓 ${site} …`);
    const html = await fetchUrl(url);
    if (!html) { console.log("    抓取失败/空"); continue; }
    const text = stripHtml(html).slice(0, 7000);
    if (!text) continue;
    const msg = `以下是竞品零售站 ${site} 搜索「${kw}」的页面文本。请提取【与"${kw}"同款/同IP】且【真实在售（排除 Pre-order/预售/Sold out/Out of stock）】的零售价(USD)，严格排除同名不同品类的无关款，以及明显偏离正常区间$${lo}-${hi}的炒价/整端/套装价。返回JSON：{"items":[{"name":"","price":数字}],"prices":[数字...],"median":中位价或null}。若无同款在售则{"prices":[],"median":null}。\n\n页面文本:\n${text}`;
    const chat = await runBl(["text", "chat", "--message", msg]);
    const j = extractJson(chatContent(chat));
    const prices = (j?.prices || []).filter((p) => typeof p === "number" && p > 0);
    if (prices.length) {
      prices.sort((a, b) => a - b);
      const median = j.median ?? prices[Math.floor(prices.length / 2)];
      console.log(`    ✓ ${site} 命中 ${prices.length} 条在售价，中位 $${median}`);
      return { retail_usd: median, source: `web-${site}(${prices.length}条)`, range: [prices[0], prices[prices.length - 1]], items: j.items };
    }
    console.log(`    ${site} 无同款在售`);
  }
  return { retail_usd: null, source: "web-all-sites-no-valid-price" };
}

// 辅助：竞品站无同款时用 bl search web 搜官网/Amazon + 炒价过滤
async function searchWebFallback(info, prof) {
  const kw = `${info.name || ""} ${info.ip || ""}`.trim() || info.category || prof.vision_hint;
  const [lo, hi] = prof.price_sane_usd;
  const res = await runBl(["search", "web", "--query", `${kw} price buy online usd`, "--count", "8"]);
  let pages = [];
  try { pages = JSON.parse(res?.content?.[0]?.text || "{}").pages || []; } catch {}
  if (!pages.length) return { retail_usd: null, source: "bl-search-web-empty" };
  const excerpt = pages.slice(0, 6).map((p, i) => `[${i + 1}] ${p.title || ""} | ${p.hostname || ""}\n${(p.snippet || "").slice(0, 500)}`).join("\n\n");
  const msg = `商品：${kw}。以下是搜索引擎找到的海外零售结果摘要。请提取【同款真实在售】的单件零售价(USD)，必须排除：Preorder/预售、国内批发价(¥/1688/阿里)、拍卖/炒作价、无关款、以及明显偏离正常零售区间$${lo}-${hi}的炒价/整端/套装价。返回JSON：{"prices":[数字...],"median":中位价或null,"used":"简述用了哪几条及排除理由"}。若全部不可信则 {"prices":[],"median":null}。\n\n搜索结果:\n${excerpt}`;
  const chat = await runBl(["text", "chat", "--message", msg]);
  const j = extractJson(chatContent(chat));
  const prices = (j?.prices || []).filter((p) => typeof p === "number" && p > 0);
  if (!prices.length) return { retail_usd: null, source: "bl-search-web-no-valid-price", note: j?.used };
  prices.sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return { retail_usd: median, source: `bl-search-web(${prices.length}条)`, range: [prices[0], prices[prices.length - 1]], note: j?.used };
}

// 【主链·核心痛点】bl search web 偏置到 profile 预选大平台（已验证 bl 可达）→ 聚合解析同款在售价
async function searchPlatformPrices(info, prof) {
  const kw = (`${info.name || ""} ${info.ip || ""}`.trim() || info.category || prof.vision_hint).split(/\s+/).slice(0, 4).join(" ");
  const [lo, hi] = prof.price_sane_usd;
  const platforms = prof.platforms || ["amazon", "ebay", "aliexpress", "temu"];
  const pool = [];
  for (const plat of platforms) {
    console.log(`  → bl 搜 ${plat} …`);
    const res = await runBl(["search", "web", "--query", `${kw} price ${plat} usd`, "--count", "8"]);
    let pages = [];
    try { pages = JSON.parse(res?.content?.[0]?.text || "{}").pages || []; } catch {}
    // 仅保留 url/snippet 确实指向该平台的结果，保证来源可溯
    const hit = pages.filter((p) => `${p.url || ""} ${p.snippet || ""}`.toLowerCase().includes(plat));
    for (const p of hit) pool.push({ plat, title: p.title || "", snippet: (p.snippet || "").slice(0, 400), url: p.url || "" });
    console.log(`    ${plat} 命中 ${hit.length} 条`);
  }
  if (!pool.length) return { retail_usd: null, source: "web-platforms-empty" };
  const excerpt = pool.slice(0, 24).map((p, i) => `[${i + 1}][${p.plat}] ${p.title}\n${p.snippet}`).join("\n\n");
  const msg = `商品：${kw}。以下是海外主流平台（${platforms.join("/")}）的在售结果摘要。请提取【同款真实在售】的单件零售价(USD)，必须排除：Preorder/预售、Sold out/缺货、Used/二手/refurbished、国内批发价(¥/1688/阿里)、拍卖/炒作价、无关款、以及明显偏离正常零售区间$${lo}-${hi}的炒价/整套/整端价。返回JSON：{"items":[{"platform":"","price":数字}],"prices":[数字...],"median":中位价或null,"platforms_hit":["平台..."],"used":"简述取舍理由"}。若全部不可信则{"prices":[],"median":null}。\n\n结果摘要:\n${excerpt}`;
  const chat = await runBl(["text", "chat", "--message", msg]);
  const j = extractJson(chatContent(chat));
  const prices = (j?.prices || []).filter((p) => typeof p === "number" && p > 0 && p >= lo && p <= hi);
  if (!prices.length) return { retail_usd: null, source: "web-platforms-no-valid-price", note: j?.used };
  prices.sort((a, b) => a - b);
  const median = j?.median && j.median >= lo && j.median <= hi ? j.median : prices[Math.floor(prices.length / 2)];
  const hits = (j?.platforms_hit || [...new Set(pool.map((p) => p.plat))]).join(",");
  console.log(`    ✓ 命中 ${prices.length} 条有效价（${hits}），中位 $${median}`);
  return { retail_usd: median, source: `web-multi(${hits};${prices.length}条)`, range: [prices[0], prices[prices.length - 1]], items: j?.items, note: j?.used };
}

// ---------- 财务核算（净利润模型）----------
function finance({ cost_cny, size_cm, size_type, pcs_set, case_count, special, retail_usd, cfg, prof }) {
  const [L, W, H] = size_cm;
  const fx = cfg.fx_usd_to_cny;
  const lg = prof.logistics;
  const redund = lg.redundancy;
  const coeff = special ? prof.unit_coeff.special : prof.unit_coeff.normal;
  const rate = lg.freight_rate_cny_per_kg;
  const minW = lg.min_ship_weight_kg;

  // 综合物流费（体积重 → 起送门槛判断）
  let pcsVolKg = (L * W * H) / lg.vol_divisor;
  if (size_type === "carton") pcsVolKg /= pcs_set;
  else if (size_type === "case") pcsVolKg /= (case_count || pcs_set);
  const cartonVolKg = pcsVolKg * coeff * redund * pcs_set;
  let shipBaseVolKg;
  if (size_type === "pcs") shipBaseVolKg = pcsVolKg * coeff * redund;             // 单件零售：按实际体积重
  else if (cartonVolKg >= minW) shipBaseVolKg = pcsVolKg * coeff * redund;        // 端盒/箱达起送
  else shipBaseVolKg = minW / pcs_set;                                           // 未达起送：拉到门槛按 pcs 分摊
  const logisticsUsd = (shipBaseVolKg * rate) / fx;

  // 净利润
  const costUsd = cost_cny / fx;
  const paymentFee = retail_usd * cfg.fees.payment_rate;
  const shrinkage = retail_usd * cfg.fees.shrinkage_rate;
  const totalCost = costUsd + logisticsUsd + paymentFee + shrinkage;
  const netProfit = retail_usd - totalCost;
  const netMargin = retail_usd > 0 ? netProfit / retail_usd : 0;
  const grossMargin = retail_usd > 0 ? (retail_usd - costUsd - logisticsUsd) / retail_usd : 0;
  const breakeven = costUsd + logisticsUsd; // 因抽成/拨备按售价比例，盈亏平衡价 = 固定成本/(1−费率和)
  const feeRateSum = cfg.fees.payment_rate + cfg.fees.shrinkage_rate;
  const breakevenPrice = feeRateSum < 1 ? breakeven / (1 - feeRateSum) : null;

  // 汇率敏感性：fx 跌 0.1 → 净利润率变化（pp）
  const costUsd2 = cost_cny / (fx - 0.1);
  const net2 = retail_usd - (costUsd2 + logisticsUsd + paymentFee + shrinkage);
  const netMargin2 = retail_usd > 0 ? net2 / retail_usd : 0;
  const fxSens = (netMargin2 - netMargin) * 100;

  const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);
  return {
    pcsVolKg: r2(pcsVolKg), cartonVolKg: r2(cartonVolKg),
    costUsd: r2(costUsd), logisticsUsd: r2(logisticsUsd),
    paymentFee: r2(paymentFee), shrinkage: r2(shrinkage), totalCost: r2(totalCost),
    netProfit: r2(netProfit), netMarginPct: r2(netMargin * 100), grossMarginPct: r2(grossMargin * 100),
    breakevenPrice: r2(breakevenPrice),
    costPct: r2((retail_usd > 0 ? costUsd / retail_usd : 0) * 100),
    fxSens: r2(fxSens), paymentRate: cfg.fees.payment_rate, shrinkageRate: cfg.fees.shrinkage_rate,
    shipBaseVolKg,
  };
}

function light(netMarginPct, cfg) {
  if (netMarginPct >= cfg.thresholds.green_net_margin * 100) return { key: "green", label: "绿灯·财务通过", verdict: "净利润率达行业健康线，建议上架" };
  if (netMarginPct < cfg.thresholds.red_net_margin * 100) return { key: "red", label: "红灯·打退", verdict: "净利润率过低，建议供应商调成本" };
  return { key: "yellow", label: "黄灯·谨慎", verdict: "净利润率临界，需控本或调价" };
}

// ---------- 财务校验（四组·硬拦截）----------
function validate({ args, cfg, prof, category, size_cm, retail_usd, priceSource, fin, allowEstimate }) {
  const F = []; // failures: {code, msg, fix}
  const near = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

  // A. 输入合法性
  if (!(args.cost > 0)) F.push({ code: "A1", msg: `采购成本非正数 (${args.cost})`, fix: "传 --cost 正数" });
  if (!(size_cm.length === 3 && size_cm.every((x) => x > 0))) F.push({ code: "A2", msg: `尺寸非法 (${size_cm.join("×")})`, fix: "传 --size LxWxH，三维均>0" });
  if (!(Number.isInteger(args.pcs_set) && args.pcs_set > 0)) F.push({ code: "A3", msg: `pcs-set 非正整数 (${args.pcs_set})`, fix: "传 --pcs-set 正整数" });
  if (args.size_type === "case" && !(args.case_count > 0)) F.push({ code: "A4", msg: "箱(case)口径缺 --case-count", fix: "补 --case-count 正数" });
  if (!["pcs", "carton", "case"].includes(args.size_type)) F.push({ code: "A5", msg: `size-type 非法 (${args.size_type})`, fix: "用 pcs|carton|case" });
  if (!(cfg.fx_usd_to_cny > 0)) F.push({ code: "A6", msg: "汇率 fx 非正", fix: "改 config.fx_usd_to_cny" });
  const pr = cfg.fees.payment_rate, sr = cfg.fees.shrinkage_rate;
  if (!(pr >= 0 && pr < 1 && sr >= 0 && sr < 1 && pr + sr < 1)) F.push({ code: "A7", msg: `费率非法 payment=${pr} shrinkage=${sr}`, fix: "费率∈[0,1) 且和<1" });
  const gm = cfg.thresholds.green_net_margin, rm = cfg.thresholds.red_net_margin;
  if (!(gm > rm && gm > 0 && gm < 1 && rm > 0 && rm < 1)) F.push({ code: "A8", msg: `红线阈值非法 green=${gm} red=${rm}`, fix: "需 0<red<green<1" });
  if (!prof) F.push({ code: "A9", msg: `品类档案不存在 (${category})`, fix: "用 config.profiles 里已有的 --category" });

  // 后续组依赖 fin/prof 存在
  if (prof && fin) {
    // B. 公式自洽
    const costUsd = args.cost / cfg.fx_usd_to_cny;
    if (!near(fin.costUsd, Math.round(costUsd * 100) / 100, 0.02)) F.push({ code: "B1", msg: `进价USD不自洽 ${fin.costUsd}≠${(costUsd).toFixed(2)}`, fix: "引擎bug，勿手改产物" });
    const recomputedTotal = fin.costUsd + fin.logisticsUsd + fin.paymentFee + fin.shrinkage;
    if (!near(fin.totalCost, Math.round(recomputedTotal * 100) / 100, 0.02)) F.push({ code: "B2", msg: `综合成本≠各项加总 ${fin.totalCost}≠${recomputedTotal.toFixed(2)}`, fix: "成本拆解不自洽" });
    const recomputedNet = retail_usd - fin.totalCost;
    if (!near(fin.netProfit, Math.round(recomputedNet * 100) / 100, 0.02)) F.push({ code: "B3", msg: `净利润≠公允价−综合成本`, fix: "净利润不自洽" });
    if (!(fin.pcsVolKg >= 0 && fin.cartonVolKg >= 0 && fin.shipBaseVolKg >= 0)) F.push({ code: "B4", msg: "体积重出现负值", fix: "检查尺寸/系数" });

    // C. 数据可信度（严肃财务核心）
    const trusted = /^web-/.test(priceSource) || priceSource === "user-ref-price";
    if (!trusted) {
      if (allowEstimate) F.push({ code: "C1-warn", msg: "价格仅模型估算（已用 --allow-estimate 放行）", fix: "演示可，正式核价请补 --ref-price 或可信竞品价", warn: true });
      else F.push({ code: "C1", msg: `价格未经可信来源验证 (${priceSource})`, fix: "补 --ref-price <真实竞品价>；或加 --allow-estimate 仅演示放行" });
    }

    // D. 结果合理性
    const [lo, hi] = prof.price_sane_usd;
    if (!(retail_usd >= lo && retail_usd <= hi)) F.push({ code: "D1", msg: `公允价 $${retail_usd} 超出品类合理区间 $${lo}-${hi}`, fix: "疑似炒价/单位错误，核对价格来源或换品类档案" });
    if (!(fin.netMarginPct >= -100 && fin.netMarginPct <= 100)) F.push({ code: "D2", msg: `净利润率越界 ${fin.netMarginPct}%`, fix: "参数异常" });
    if (!(fin.grossMarginPct >= fin.netMarginPct - 0.02)) F.push({ code: "D3", msg: `毛利率 < 净利率（不可能）`, fix: "公式异常" });
    if (!(fin.costPct <= 100.02)) F.push({ code: "D4", msg: `进价占比 >100% (${fin.costPct}%)`, fix: "成本或售价异常" });
  }

  return { pass: F.filter((f) => !f.warn).length === 0, failures: F };
}

// ---------- Bento Box 海报 ----------
async function renderPoster(d) {
  const tpl = await readFile(path.join(ROOT, "poster.html"), "utf8");
  const badge = d.validation.pass
    ? `<span style="color:#1aa260">✓ 公式自洽</span> · <span style="color:#1aa260">✓ 价格${d.priceTrusted ? "可信" : "估算·未验证"}</span> · <span style="color:#1aa260">✓ 参数合理</span>`
    : `<span style="color:#d64545">✗ 校验未通过</span>`;
  const out = tpl
    .replace(/{{LIGHT_KEY}}/g, d.light.key)
    .replace(/{{LIGHT_LABEL}}/g, d.light.label)
    .replace(/{{VERDICT}}/g, d.light.verdict)
    .replace(/{{NAME}}/g, d.name)
    .replace(/{{IP}}/g, d.ip || "—")
    .replace(/{{CATEGORY}}/g, d.category)
    .replace(/{{SPECIAL_LABEL}}/g, d.specialLabel || "标准")
    .replace(/{{RETAIL}}/g, String(d.retail_usd))
    .replace(/{{NET_MARGIN}}/g, String(d.fin.netMarginPct))
    .replace(/{{GROSS_MARGIN}}/g, String(d.fin.grossMarginPct))
    .replace(/{{NET_PROFIT}}/g, String(d.fin.netProfit))
    .replace(/{{BREAKEVEN}}/g, d.fin.breakevenPrice == null ? "—" : String(d.fin.breakevenPrice))
    .replace(/{{COST_CNY}}/g, String(d.cost_cny))
    .replace(/{{COST_USD}}/g, String(d.fin.costUsd))
    .replace(/{{LOGISTICS}}/g, String(d.fin.logisticsUsd))
    .replace(/{{PAYMENT}}/g, String(d.fin.paymentFee))
    .replace(/{{PAYMENT_RATE}}/g, (d.fin.paymentRate * 100).toFixed(0))
    .replace(/{{SHRINKAGE}}/g, String(d.fin.shrinkage))
    .replace(/{{SHRINKAGE_RATE}}/g, (d.fin.shrinkageRate * 100).toFixed(0))
    .replace(/{{TOTAL_COST}}/g, String(d.fin.totalCost))
    .replace(/{{COST_PCT}}/g, String(d.fin.costPct))
    .replace(/{{FX}}/g, String(d.cfg.fx_usd_to_cny))
    .replace(/{{FX_SENS}}/g, String(d.fin.fxSens))
    .replace(/{{SIZE}}/g, d.size_cm.join("×"))
    .replace(/{{PCS_VOL}}/g, String(d.fin.pcsVolKg))
    .replace(/{{CARTON_VOL}}/g, String(d.fin.cartonVolKg))
    .replace(/{{PCS_SET}}/g, String(d.pcs_set))
    .replace(/{{PRICE_SRC}}/g, d.priceSrc)
    .replace(/{{VALIDATION_BADGE}}/g, badge);
  const outFile = d.outFile || path.join(ROOT, "out", "poster.html");
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, out, "utf8");
  return outFile;
}

// ---------- CSV（零依赖）----------
function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inQ = false;
  const pushF = () => { row.push(field); field = ""; };
  const pushR = () => { if (row.length > 1 || row[0] !== "") rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") pushF();
    else if (c === "\n") { pushF(); pushR(); }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length) { pushF(); pushR(); }
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
}

// CSV 行 → args 契约
function rowToArgs(rec) {
  const num = (v) => (v === "" || v == null ? undefined : Number(v));
  const truthy = (v) => /^(1|true|yes|y|是|毛绒)$/i.test(String(v || ""));
  return {
    name: rec.name || rec.名称 || "", ip: rec.ip || "", category: rec.category || rec.品类 || "",
    cost: num(rec.cost ?? rec.成本), size: rec.size || rec.尺寸 || "",
    size_type: rec.size_type || rec.口径 || "carton", pcs_set: num(rec.pcs_set ?? rec.件数),
    case_count: num(rec.case_count), plushie: truthy(rec.special ?? rec.plushie ?? rec.毛绒),
    ref_price: num(rec.ref_price ?? rec.参考价), allow_estimate: false,
  };
}

function abort(failures) {
  console.error("\n❌ 财务校验未通过 —— 已中止，未生成海报（严肃财务，容不得失误）");
  for (const f of failures.filter((x) => !x.warn)) console.error(`  [${f.code}] ${f.msg}\n        → 修正：${f.fix}`);
  process.exit(2);
}

// 缺必填字段清单（单/批共用；批量据此 exit 3 向用户要数据）
function missingFields(args) {
  const m = [];
  if (!args.image && !args.name) m.push("name(或image)");
  if (args.cost == null || Number.isNaN(args.cost)) m.push("cost");
  if (!args.size) m.push("size");
  if (!args.pcs_set) m.push("pcs_set");
  return m;
}

// ---------- 单 SKU 核价（可复用；返回结果对象，不 exit）----------
async function priceOne(args, cfg, { outFile, silent = false } = {}) {
  const log = silent ? () => {} : (...a) => console.log(...a);
  const size_cm = String(args.size ?? "").split(/[x×X]/).map(Number);

  let info;
  if (args.name) {
    info = { name: args.name, ip: args.ip || "", category: args.category || "", is_special: args.plushie };
    log("① 商品 →", JSON.stringify(info));
  } else {
    log("① 识别商品…");
    const dp = cfg.profiles[cfg.default_category];
    info = await recognize(args.image, args.category ? cfg.profiles[args.category]?.vision_hint : dp?.vision_hint);
    log("  →", JSON.stringify(info));
  }

  if (args.category && !matchProfile(cfg, args.category))
    return { ok: false, name: info.name, failures: [{ code: "A9", msg: `品类档案不存在 (${args.category})`, fix: `用：${Object.keys(cfg.profiles).join(" / ")}` }] };
  const category = matchProfile(cfg, args.category) || matchProfile(cfg, info.category) || cfg.default_category || Object.keys(cfg.profiles)[0];
  const prof = cfg.profiles[category];
  log(`  品类档案 → ${category}${args.category ? "" : "（自动匹配）"}`);

  log("② 取海外公允价…");
  let retail_usd, priceSrc, priceSource, priceTrusted;
  if (args.ref_price) {
    retail_usd = args.ref_price; priceSource = "user-ref-price"; priceTrusted = true;
    priceSrc = "用户竞品参考价 $" + retail_usd; log("  →", priceSrc);
  } else {
    log("  → [痛点核心] bl 搜预选大平台在售有效价…");
    const found = await searchPlatformPrices(info, prof);
    if (found.retail_usd != null) {
      retail_usd = found.retail_usd; priceSource = found.source; priceTrusted = true;
      priceSrc = found.source + (found.range ? `（$${found.range[0]}~$${found.range[1]}）` : ""); log("  →", priceSrc);
    } else {
      log("  → 联网仍无有效价，回落模型估算…");
      const est = await estimateRetail(info, prof);
      retail_usd = est.retail_usd; priceSource = est.source; priceTrusted = false;
      priceSrc = "model-fallback·" + est.source + (est.range ? `（$${est.range[0]}~$${est.range[1]}）` : ""); log("  →", priceSrc);
    }
  }

  log("③ 财务核算…");
  const special = args.plushie || !!info.is_special;
  const fin = finance({ cost_cny: args.cost, size_cm, size_type: args.size_type, pcs_set: args.pcs_set, case_count: args.case_count, special, retail_usd, cfg, prof });
  const lt = light(fin.netMarginPct, cfg);
  log(`  → 公允价 $${retail_usd}  净利率 ${fin.netMarginPct}%  单件净利 $${fin.netProfit}  盈亏平衡 $${fin.breakevenPrice}  ${lt.label}`);

  log("④ 财务校验（四组·硬拦截）…");
  const vr = validate({ args, cfg, prof, category, size_cm, retail_usd, priceSource, fin, allowEstimate: args.allow_estimate });
  for (const w of vr.failures.filter((f) => f.warn)) log(`  ⚠️ [${w.code}] ${w.msg}`);
  if (!vr.pass) return { ok: false, name: info.name, category, failures: vr.failures };
  log("  ✅ 财务校验通过（A/B/C/D 全过）");

  const poster = await renderPoster({ light: lt, name: info.name, ip: info.ip, category, specialLabel: special ? (prof.unit_coeff.special_label || "特殊") : "标准", cost_cny: args.cost, size_cm, size_type: args.size_type, pcs_set: args.pcs_set, retail_usd, fin, priceSrc, priceTrusted, validation: vr, cfg, outFile });
  return { ok: true, name: info.name, ip: info.ip, category, retail_usd, priceSrc, priceTrusted, fin, light: lt, poster };
}

// ---------- 批量汇总页 ----------
async function renderSummary(rows, outFile) {
  const tr = rows.map((r) => {
    const c = r.ok ? (r.light.key === "green" ? "#1aa260" : r.light.key === "red" ? "#d64545" : "#e0a800") : "#86909c";
    return `<tr><td>${r.name}</td><td>${r.category || "—"}</td><td class="amt">${r.ok ? "$" + r.retail_usd : "—"}</td><td class="amt" style="color:${c};font-weight:700">${r.ok ? r.fin.netMarginPct + "%" : "—"}</td><td style="color:${c}">${r.ok ? r.light.label : "✗ " + (r.failures[0]?.code || "") + " " + (r.failures[0]?.msg || "")}</td><td>${r.ok ? `<a href="${path.basename(r.poster)}">海报</a>` : "—"}</td></tr>`;
  }).join("\n");
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>批量核价汇总</title><style>body{font-family:-apple-system,"PingFang SC",sans-serif;background:#f4f5f7;color:#1d2129;padding:28px}h1{font-size:20px}table{width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.06)}td,th{padding:12px 14px;text-align:left;border-bottom:1px solid #eef0f3;font-size:14px}th{color:#86909c;font-weight:500;background:#fafbfc}.amt{text-align:right;font-variant-numeric:tabular-nums}.foot{color:#a0a4ab;font-size:12px;margin-top:14px}</style></head><body><h1>跨境批量核价汇总 · ${rows.length} 款</h1><table><tr><th>商品</th><th>品类</th><th class="amt">公允价</th><th class="amt">净利率</th><th>结论</th><th>海报</th></tr>${tr}</table><div class="foot">固化流程 · bl 搜预选大平台 · 四组财务校验硬拦截</div></body></html>`;
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(outFile, html, "utf8");
  return outFile;
}

const slug = (s, i) => (String(s || "sku").replace(/[^\w一-龥-]+/g, "_").slice(0, 30) || "sku") + "_" + i;

// ---------- 批量入口 ----------
async function runBatch(batchFile, cfg) {
  const text = await readFile(path.resolve(batchFile), "utf8");
  const recs = parseCsv(text);
  if (!recs.length) { console.error("❌ CSV 无数据行"); process.exit(1); }
  console.log(`读取 ${recs.length} 行，预检必填字段…`);

  // 缺数据先问：任一行缺必填 → 汇总 exit 3
  const rowsArgs = recs.map(rowToArgs);
  const gaps = rowsArgs.map((a, i) => ({ line: i + 2, name: a.name || "(未命名)", miss: missingFields(a) })).filter((g) => g.miss.length);
  if (gaps.length) {
    console.error("\n⛔ 缺数据，已中止（请补齐后重跑）——需要向用户索要：");
    for (const g of gaps) console.error(`  第 ${g.line} 行「${g.name}」缺：${g.miss.join("、")}`);
    process.exit(3);
  }

  const outDir = path.join(ROOT, "out", "batch");
  const results = [];
  for (let i = 0; i < rowsArgs.length; i++) {
    const a = rowsArgs[i];
    a.allow_estimate = parseArgs(process.argv).allow_estimate; // 继承全局逃生阀
    console.log(`\n——— [${i + 1}/${rowsArgs.length}] ${a.name} ———`);
    try {
      const r = await priceOne(a, cfg, { outFile: path.join(outDir, slug(a.name, i + 1) + ".html") });
      results.push(r);
      console.log(r.ok ? `  ✅ ${r.light.label} 净利率 ${r.fin.netMarginPct}%` : `  ✗ 校验未过：${r.failures.map((f) => f.code).join(",")}`);
    } catch (e) { results.push({ ok: false, name: a.name, failures: [{ code: "ERR", msg: e.message }] }); console.log("  ✗ 异常：" + e.message); }
  }

  const summary = await renderSummary(results, path.join(outDir, "summary.html"));
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== 批量完成：${pass}/${results.length} 通过 ===`);
  console.log("汇总页 →", summary);
  console.log(JSON.stringify(results.map((r) => ({ name: r.name, category: r.category, ok: r.ok, retail_usd: r.retail_usd, net_margin_pct: r.ok ? r.fin.netMarginPct : null, light: r.ok ? r.light.key : null, fail: r.ok ? null : r.failures.map((f) => f.code + ":" + f.msg) })), null, 2));
  if (os.platform() === "darwin") exec(`open "${summary}"`);
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);
  const cfg = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));

  if (args.batch) return runBatch(args.batch, cfg);

  // 单 SKU：早期缺字段硬拦截
  const miss = missingFields(args);
  if (miss.length) abort(miss.map((f) => ({ code: "A", msg: `缺 ${f}`, fix: `补 --${f.split("(")[0]}` })));

  const r = await priceOne(args, cfg);
  if (!r.ok) abort(r.failures);
  console.log("⑤ Bento Box 海报 →", r.poster);
  console.log("\n=== 核价结果 ===");
  console.log(JSON.stringify({
    category: r.category, product: { name: r.name, ip: r.ip },
    input: { cost_cny: args.cost, size_type: args.size_type, pcs_set: args.pcs_set, ref_price: args.ref_price },
    price_source: r.priceSrc, price_trusted: r.priceTrusted, retail_usd: r.retail_usd,
    finance: r.fin, light: r.light.key, net_margin_pct: r.fin.netMarginPct, poster: r.poster,
  }, null, 2));
  if (os.platform() === "darwin") exec(`open "${r.poster}"`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
