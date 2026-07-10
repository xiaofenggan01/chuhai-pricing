#!/usr/bin/env node
// 跨境核价决策官 — 跨境零售净利润核价（Bento Box 财务合规）
// 净利润 = 海外均价 − 进价 − 综合物流费 − (均价×支付费率) − (均价×货损率)
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
  const a = { size_type: "carton", plushie: false };
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
      case "--plushie": a.plushie = true; break;
      case "--ref-price": a.ref_price = Number(argv[++i]); break;
    }
  }
  return a;
}

// ---------- bl runner ----------
function runBl(cmdArgs, { timeout = 90, retries = 1 } = {}) {
  const attempt = (t) => new Promise((resolve, reject) => {
    execFile(BL, [...cmdArgs, "--output", "json", "--timeout", String(t)], { maxBuffer: 1 << 26 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`bl failed: ${err.message}\n${stderr}`));
      const out = stdout.trim();
      try { resolve(JSON.parse(out)); } catch { resolve({ __text: out }); }
    });
  });
  return attempt(timeout).catch((e) => {
    if (retries <= 0) throw e;
    console.log("  ⚠️ 超时/出错，重试中…");
    return attempt(timeout + 30);
  });
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

// ---------- vision ----------
async function recognize(image) {
  const prompt = "识别图中的潮玩/盲盒商品。只返回JSON：name(商品名),ip(品牌或IP),category(品类),is_plushie(是否毛绒,true/false)。不要其他文字。";
  const res = await runBl(["vision", "describe", "--image", image, "--prompt", prompt]);
  const j = extractJson(chatContent(res));
  return j ?? { name: "未知商品", ip: "", category: "潮玩盲盒", is_plushie: false };
}

// ---------- 取价 ----------
async function estimateRetail(info) {
  const msg = `商品：${info.name}（IP：${info.ip || "未知"}，品类：${info.category || "潮玩盲盒"}）。给该商品或同类潮玩在海外零售站点的常见零售价(USD)。只返回JSON：{"retail_usd_low":数字,"retail_usd_high":数字,"retail_usd":建议中位价}。不要其他文字。`;
  const res = await runBl(["text", "chat", "--message", msg]);
  const j = extractJson(chatContent(res));
  const mid = j?.retail_usd ?? (j && j.retail_usd_low != null && j.retail_usd_high != null ? (j.retail_usd_low + j.retail_usd_high) / 2 : null);
  return { retail_usd: mid ?? 19.99, source: mid != null ? "model-estimate" : "model-fallback", range: j && j.retail_usd_low != null ? [j.retail_usd_low, j.retail_usd_high] : null };
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

// 【核心痛点】图/名称 → 竞品在售有效价：遍历 SOP 站抓站内搜 → 解析同款在售价（排除预售/缺货/炒价）
async function searchCompetitorPrices(info, cfg) {
  const raw = `${info.name || ""} ${info.ip || ""}`.trim() || info.category || "blind box";
  const kw = raw.split(/\s+/).slice(0, 3).join(" ");
  for (const site of cfg.competitor_sites || []) {
    const url = `https://${site}/search?q=${encodeURIComponent(kw)}`;
    console.log(`  → 抓 ${site} …`);
    const html = await fetchUrl(url);
    if (!html) { console.log("    抓取失败/空"); continue; }
    const text = stripHtml(html).slice(0, 7000);
    if (!text) continue;
    const msg = `以下是竞品零售站 ${site} 搜索「${kw}」的页面文本。请提取【与"${kw}"同款/同IP】且【真实在售（排除 Pre-order/预售/Sold out/Out of stock）】的零售价(USD)，严格排除同名不同IP的无关款、以及明显高于正常区间的炒价（潮玩单品正常$8-40，$60+视为炒价/整端排除）。返回JSON：{"items":[{"name":"","price":数字}],"prices":[数字...],"median":中位价或null}。若无同款在售则{"prices":[],"median":null}。\n\n页面文本:\n${text}`;
    const chat = await runBl(["text", "chat", "--message", msg]);
    const j = extractJson(chatContent(chat));
    const prices = (j?.prices || []).filter(p => typeof p === "number" && p > 0);
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

// 辅助：Shopify 站无同款时（多为旗舰 IP），用 bl search web 搜官网/Amazon + 炒价过滤
async function searchWebFallback(info) {
  const kw = `${info.name || ""} ${info.ip || ""}`.trim() || info.category || "blind box";
  const res = await runBl(["search", "web", "--query", `${kw} popmart amazon price buy online`, "--count", "8"]);
  let pages = [];
  try { pages = JSON.parse(res?.content?.[0]?.text || "{}").pages || []; } catch {}
  if (!pages.length) return { retail_usd: null, source: "bl-search-web-empty" };
  const excerpt = pages.slice(0, 6).map((p, i) => `[${i + 1}] ${p.title || ""} | ${p.hostname || ""}\n${(p.snippet || "").slice(0, 500)}`).join("\n\n");
  const msg = `商品：${kw}。以下是通过搜索引擎找到的海外零售结果摘要（可能含官网/Amazon）。请提取【同款真实在售】的单件零售价(USD)，必须排除：Preorder/预售、国内批发价(¥/1688/阿里)、拍卖或炒作价、明显无关款、以及明显高于正常零售区间的炒作/整端价（潮玩盲盒/figure 单品正常约 $8-40，$60+ 视为炒价/整端/拍卖，一律排除）。返回JSON：{"prices":[数字...],"median":中位价或null,"used":"简述用了哪几条及排除理由"}。若全部不可信则 {"prices":[],"median":null}。\n\n搜索结果:\n${excerpt}`;
  const chat = await runBl(["text", "chat", "--message", msg]);
  const j = extractJson(chatContent(chat));
  const prices = (j?.prices || []).filter(p => typeof p === "number" && p > 0);
  if (!prices.length) return { retail_usd: null, source: "bl-search-web-no-valid-price", note: j?.used };
  prices.sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return { retail_usd: median, source: `bl-search-web(${prices.length}条)`, range: [prices[0], prices[prices.length - 1]], note: j?.used };
}

// ---------- 财务核算（净利润模型）----------
function finance({ cost_cny, size_cm, size_type, pcs_set, case_count, plushie, retail_usd, cfg }) {
  const [L, W, H] = size_cm;
  const fx = cfg.fx_usd_to_cny;
  const redund = cfg.logistics.redundancy;
  const plushCoeff = plushie ? cfg.plushie_coeff.plushie : cfg.plushie_coeff.normal;
  const rate = cfg.logistics.freight_rate_cny_per_kg;
  const minW = cfg.logistics.min_ship_weight_kg;

  // 综合物流费（SOP 体积重 → 起送门槛判断）
  let pcsVolKg = (L * W * H) / cfg.logistics.vol_divisor;
  if (size_type === "carton") pcsVolKg /= pcs_set;
  else if (size_type === "case") pcsVolKg /= (case_count || pcs_set);
  const cartonVolKg = pcsVolKg * plushCoeff * redund * pcs_set;
  let shipBaseVolKg;
  if (size_type === "pcs") shipBaseVolKg = pcsVolKg * plushCoeff * redund;           // 单件零售：按实际体积重
  else if (cartonVolKg >= minW) shipBaseVolKg = pcsVolKg * plushCoeff * redund;      // 端盒/箱达起送
  else shipBaseVolKg = minW / pcs_set;                                               // 未达起送：拉到 2.5kg 按 pcs 分摊
  const logisticsUsd = (shipBaseVolKg * rate) / fx;

  // 净利润
  const costUsd = cost_cny / fx;
  const paymentFee = retail_usd * cfg.fees.payment_rate;
  const shrinkage = retail_usd * cfg.fees.shrinkage_rate;
  const totalCost = costUsd + logisticsUsd + paymentFee + shrinkage;
  const netProfit = retail_usd - totalCost;
  const netMargin = retail_usd > 0 ? netProfit / retail_usd : 0;
  const grossMargin = retail_usd > 0 ? (retail_usd - costUsd - logisticsUsd) / retail_usd : 0;

  // 汇率敏感性：fx 跌 0.1 → 净利润率变化（pp）
  const costUsd2 = cost_cny / (fx - 0.1);
  const net2 = retail_usd - (costUsd2 + logisticsUsd + paymentFee + shrinkage);
  const netMargin2 = retail_usd > 0 ? net2 / retail_usd : 0;
  const fxSens = (netMargin2 - netMargin) * 100;

  const r2 = (n) => Math.round(n * 100) / 100;
  return {
    pcsVolKg: r2(pcsVolKg), cartonVolKg: r2(cartonVolKg),
    costUsd: r2(costUsd), logisticsUsd: r2(logisticsUsd),
    paymentFee: r2(paymentFee), shrinkage: r2(shrinkage), totalCost: r2(totalCost),
    netProfit: r2(netProfit), netMarginPct: r2(netMargin * 100), grossMarginPct: r2(grossMargin * 100),
    costPct: r2((retail_usd > 0 ? costUsd / retail_usd : 0) * 100),
    fxSens: r2(fxSens), paymentRate: cfg.fees.payment_rate, shrinkageRate: cfg.fees.shrinkage_rate,
  };
}

function light(netMarginPct, cfg) {
  if (netMarginPct >= cfg.thresholds.green_net_margin * 100) return { key: "green", label: "绿灯·财务通过", verdict: "净利润率达行业健康线，建议上架" };
  if (netMarginPct < cfg.thresholds.red_net_margin * 100) return { key: "red", label: "红灯·打退", verdict: "净利润率过低，建议供应商调成本" };
  return { key: "yellow", label: "黄灯·谨慎", verdict: "净利润率临界，需控本或调价" };
}

// ---------- Bento Box 海报 ----------
async function renderPoster(d) {
  const tpl = await readFile(path.join(ROOT, "poster.html"), "utf8");
  const out = tpl
    .replace(/{{LIGHT_KEY}}/g, d.light.key)
    .replace(/{{LIGHT_LABEL}}/g, d.light.label)
    .replace(/{{VERDICT}}/g, d.light.verdict)
    .replace(/{{NAME}}/g, d.name)
    .replace(/{{IP}}/g, d.ip || "—")
    .replace(/{{RETAIL}}/g, String(d.retail_usd))
    .replace(/{{NET_MARGIN}}/g, String(d.fin.netMarginPct))
    .replace(/{{GROSS_MARGIN}}/g, String(d.fin.grossMarginPct))
    .replace(/{{NET_PROFIT}}/g, String(d.fin.netProfit))
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
    .replace(/{{PRICE_SRC}}/g, d.priceSrc);
  const outDir = path.join(ROOT, "out");
  await mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "poster.html");
  await writeFile(outFile, out, "utf8");
  return outFile;
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv);
  const missing = [];
  if (!args.image && !args.name) missing.push("--image(或 --name)");
  if (!args.cost) missing.push("--cost");
  if (!args.size) missing.push("--size");
  if (!args.pcs_set) missing.push("--pcs-set");
  if (missing.length) {
    console.error("缺少参数: " + missing.join(", "));
    console.error("用法: node run.mjs --image <图> 或 --name <名> --cost <¥> --size <LxWxH> --size-type <pcs|carton|case> --pcs-set <n> [--plushie] [--ref-price <usd>]");
    process.exit(1);
  }
  const cfg = JSON.parse(await readFile(path.join(ROOT, "config.json"), "utf8"));
  const size_cm = String(args.size).split(/[x×X]/).map(Number);
  if (size_cm.length !== 3 || size_cm.some(isNaN)) { console.error("--size 格式错，需 LxWxH，如 30x20x20"); process.exit(1); }

  let info;
  if (args.name) {
    info = { name: args.name, ip: args.ip || "", category: args.category || "潮玩盲盒", is_plushie: args.plushie };
    console.log("① 商品（用户提供名称）→", JSON.stringify(info));
  } else {
    console.log("① 识别商品…");
    info = await recognize(args.image);
    console.log("  →", JSON.stringify(info));
  }

  console.log("② 取海外均价…");
  let retail_usd, priceSrc;
  if (args.ref_price) {
    retail_usd = args.ref_price;
    priceSrc = "用户提供的竞品参考价 $" + retail_usd;
    console.log("  →", priceSrc);
  } else {
    console.log("  → [痛点核心] 联网搜竞品在售有效价…");
    let found = await searchCompetitorPrices(info, cfg);
    if (found.retail_usd == null) {
      console.log("  → 竞品站无同款，bl search web 辅助…");
      found = await searchWebFallback(info);
    }
    if (found.retail_usd != null) {
      retail_usd = found.retail_usd;
      priceSrc = found.source + (found.range ? `（$${found.range[0]}~$${found.range[1]}）` : "");
      console.log("  →", priceSrc);
    } else {
      console.log("  → 联网仍无有效价，回落模型估算…");
      const est = await estimateRetail(info);
      retail_usd = est.retail_usd;
      priceSrc = "model-fallback·" + est.source + (est.range ? `（$${est.range[0]}~$${est.range[1]}）` : "");
      console.log("  →", priceSrc);
    }
  }

  console.log("③ 财务核算…");
  const plushie = args.plushie || !!info.is_plushie;   // 未传 --plushie 时用 vision 判断
  const fin = finance({ cost_cny: args.cost, size_cm, size_type: args.size_type, pcs_set: args.pcs_set, case_count: args.case_count, plushie, retail_usd, cfg });
  const lt = light(fin.netMarginPct, cfg);
  console.log(`  → 海外均价 $${retail_usd}  净利润率 ${fin.netMarginPct}%  单件净利 $${fin.netProfit}  ${lt.label}`);

  console.log("④ 生成 Bento Box 海报…");
  const poster = await renderPoster({ light: lt, name: info.name, ip: info.ip, cost_cny: args.cost, size_cm, size_type: args.size_type, pcs_set: args.pcs_set, retail_usd, fin, priceSrc, cfg });
  console.log("  →", poster);

  console.log("\n=== 核价结果 ===");
  console.log(JSON.stringify({
    product: info,
    input: { cost_cny: args.cost, size_cm, size_type: args.size_type, pcs_set: args.pcs_set, plushie: args.plushie, ref_price: args.ref_price },
    price_source: priceSrc, retail_usd,
    finance: fin, light: lt.key, net_margin_pct: fin.netMarginPct, poster,
  }, null, 2));

  if (os.platform() === "darwin") exec(`open "${poster}"`);
}

main().catch((e) => { console.error("❌", e.message); process.exit(1); });
