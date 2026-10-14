/*
 * Общая логика трекера: даты, деньги, проверка реквизитов, назначение платежа,
 * объединение документов в платёжки и файл обмена с банком (1CClientBankExchange).
 * Работает и в браузере (window.Core), и в Node (require("./core.js")).
 */
(function (root, factory) {
  const m = factory();
  if (typeof module === "object" && module.exports) module.exports = m;
  else root.Core = m;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  const TYPES = { upd: "УПД", invoice: "Счёт", waybill: "Накладная", act: "Акт" };
  const SOURCES = { paper: "бумага", diadoc: "Диадок", other: "другое" };
  const VATS = [["22", "22%"], ["10", "10%"], ["20", "20%"], ["7", "7%"], ["5", "5%"], ["0", "0%"], ["none", "Без НДС"]];
  const DEFAULT_DAYS = [1, 4]; // понедельник и четверг
  const PURPOSE_MAX = 210;

  /* ---------- даты ---------- */
  const iso = d => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const today = () => iso(new Date());
  const D = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const ru = s => s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(0, 4) : "";
  const ruShort = s => s ? s.slice(8, 10) + "." + s.slice(5, 7) + "." + s.slice(2, 4) : "";
  const human = s => { const d = D(s); return WD[d.getDay()] + ", " + d.getDate() + " " + MON[d.getMonth()]; };
  const diff = (a, b) => Math.round((D(b) - D(a)) / 864e5);
  const addDays = (s, n) => { const d = D(s); d.setDate(d.getDate() + n); return iso(d); };
  const validISO = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ""));

  /* ---------- деньги (в копейках) ---------- */
  const digits = s => String(s ?? "").replace(/\D/g, "");
  const kop = v => {
    if (v == null || v === "") return 0;
    if (typeof v === "number") return Math.round(v * 100);
    const s = String(v).replace(/[\s ]/g, "").replace(",", ".").replace(/[^\d.-]/g, "");
    const n = parseFloat(s); return isFinite(n) ? Math.round(n * 100) : 0;
  };
  const rub = k => (k / 100).toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rubIn = k => k ? (k / 100).toFixed(2).replace(".", ",") : "";
  const dot = k => (k / 100).toFixed(2);
  const vatOf = (amount, rate) => (!rate || rate === "none") ? 0 : Math.round(amount * Number(rate) / (100 + Number(rate)));
  const plural = (n, a, b, c) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? a : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) ? b : c; };
  const sum = (arr, f = x => x.amount || 0) => arr.reduce((s, x) => s + f(x), 0);
  const groupBy = (arr, f) => { const m = new Map(); arr.forEach(x => { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };

  /* ---------- проверка реквизитов ---------- */
  function innOk(v) {
    const d = digits(v).split("").map(Number);
    if (d.length === 10) { const w = [2, 4, 10, 3, 5, 9, 4, 6, 8]; return w.reduce((s, k, i) => s + k * d[i], 0) % 11 % 10 === d[9]; }
    if (d.length === 12) {
      const w1 = [7, 2, 4, 10, 3, 5, 9, 4, 6, 8], w2 = [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8];
      return w1.reduce((s, k, i) => s + k * d[i], 0) % 11 % 10 === d[10] && w2.reduce((s, k, i) => s + k * d[i], 0) % 11 % 10 === d[11];
    }
    return false;
  }
  function key23(s) { const w = [7, 1, 3]; let t = 0; for (let i = 0; i < 23; i++) t += (+s[i] * w[i % 3]) % 10; return t % 10 === 0; }
  function accOk(acc, bik) { const a = digits(acc), b = digits(bik); if (a.length !== 20 || b.length !== 9) return false; return key23(b.slice(-3) + a); }
  function corrOk(corr, bik) { const c = digits(corr), b = digits(bik); if (c.length !== 20 || b.length !== 9) return false; return key23("0" + b.slice(4, 6) + c); }
  function reqProblems(r) {
    r = r || {};
    const p = [];
    if (!String(r.name || "").trim()) p.push("нет названия");
    if (!digits(r.inn)) p.push("нет ИНН"); else if (!innOk(r.inn)) p.push("ИНН не проходит проверку");
    if (digits(r.inn).length === 10 && digits(r.kpp).length !== 9) p.push("КПП должен быть из 9 цифр");
    if (digits(r.bik).length !== 9) p.push("БИК должен быть из 9 цифр");
    if (digits(r.account).length !== 20) p.push("р/с должен быть из 20 цифр");
    else if (digits(r.bik).length === 9 && !accOk(r.account, r.bik)) p.push("р/с не сходится с БИК — проверьте цифры");
    if (digits(r.corr).length !== 20) p.push("к/с должен быть из 20 цифр");
    else if (digits(r.bik).length === 9 && !corrOk(r.corr, r.bik)) p.push("к/с не сходится с БИК");
    if (!String(r.bank || "").trim()) p.push("нет названия банка");
    return p;
  }

  /* ---------- данные ---------- */
  const emptyData = () => ({ version: 1, orgs: [], suppliers: [], docs: [] });
  const orgById = (data, id) => data.orgs.find(o => o.id === id);
  const supByInn = (data, inn) => data.suppliers.find(s => digits(s.inn) === digits(inn) && digits(inn));
  const payDays = (data, orgId) => { const o = orgById(data, orgId) || data.orgs[0]; return (o && Array.isArray(o.payDays) && o.payDays.length) ? o.payDays : DEFAULT_DAYS; };
  function nextPay(days, from) { from = from || today(); for (let i = 0; i < 8; i++) { const s = addDays(from, i); if (days.includes(D(s).getDay())) return s; } return from; }
  // Оплаченные предоплаты, к которым ещё не пришёл закрывающий УПД
  const openPrepays = (data, inn) => data.docs.filter(d => d.prepay && d.status === "paid" && !d.closedBy && (!inn || digits(d.supplierInn) === digits(inn)));
  // Срок оплаты документа: из самого документа, а если его нет — дата документа + отсрочка поставщика (deferDays)
  function dueOf(data, d) {
    if (d.due) return d.due;
    const days = Number((supByInn(data, d.supplierInn) || {}).deferDays) || 0;
    return days > 0 && validISO(d.date) ? addDays(d.date, days) : "";
  }
  // Откуда срок: "doc" — указан в документе, "defer" — посчитан по отсрочке, "" — срока нет
  const dueSource = (data, d) => d.due ? "doc" : dueOf(data, d) ? "defer" : "";
  function stOf(data, d, t) {
    if (d.status === "paid") return "paid";
    if (d.status === "bank") return "bank";
    t = t || today();
    const due = dueOf(data, d);
    if (due && due < t) return "overdue";
    if (due && due < nextPay(payDays(data, d.orgId), t)) return "soon";
    return "unpaid";
  }

  /* ---------- назначение платежа ---------- */
  // 011026-3215 от 01.10.2026 → 3215 (первая часть номера повторяет дату)
  function autoPayNum(num, date) {
    num = String(num || "").trim();
    const m = /^(\d{6})\s*[-–\/]\s*(\S+)$/.exec(num);
    if (m && validISO(date)) { const k = date.slice(8, 10) + date.slice(5, 7) + date.slice(2, 4); if (m[1] === k) return m[2]; }
    return num;
  }
  const payNum = d => (d.numberPay && String(d.numberPay).trim()) || autoPayNum(d.number, d.date);
  // «Оплата за запчасти Счет 3215, 3216 от 01.10.26г., 3301 от 03.10.26г. В том числе НДС 22.00 % - 710.85 р.»
  function purposeText(items, sup) {
    sup = sup || {};
    const subj = String(sup.subject || "").trim(), word = String(sup.docWord ?? "Счет").trim();
    const byDate = new Map();
    [...items].sort((a, b) => (a.date || "").localeCompare(b.date || "")).forEach(d => {
      const k = d.date || ""; if (!byDate.has(k)) byDate.set(k, []); byDate.get(k).push(payNum(d));
    });
    const refs = [...byDate].map(([dt, nums]) => nums.join(", ") + (dt ? " от " + ruShort(dt) + "г." : "")).join(", ");
    const rates = new Map(); items.forEach(d => { const r = d.vatRate || "none"; rates.set(r, (rates.get(r) || 0) + (d.vat || 0)); });
    const parts = [...rates].filter(([r]) => r !== "none").map(([r, v]) => "НДС " + Number(r).toFixed(2) + " % - " + dot(v) + " р.");
    const vat = parts.length ? "В том числе " + parts.join(", ") : "НДС не облагается";
    // contract — «№ 3831/180918-КЛ от 18.09.2018», если поставщик просит указывать договор
    const contract = String(sup.contract || "").trim();
    return ("Оплата" + (contract ? " по договору " + contract : "") + (subj ? " за " + subj : "") + (word ? " " + word : "") + " " + refs + " " + vat).replace(/\s+/g, " ").trim();
  }
  // Делит документы поставщика на платёжки так, чтобы назначение влезло в 210 символов
  function pack(items, sup) {
    const sorted = [...items].sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const chunks = []; let cur = [];
    for (const d of sorted) { const t = [...cur, d]; if (cur.length && purposeText(t, sup).length > PURPOSE_MAX) { chunks.push(cur); cur = [d]; } else cur = t; }
    if (cur.length) chunks.push(cur);
    return chunks;
  }

  /* ---------- план выгрузки ---------- */
  // off — Set id документов, которые не платим сейчас
  function exportPlan(data, orgId, opts) {
    opts = opts || {};
    const off = opts.off || new Set();
    const org = orgById(data, orgId);
    if (!org) return { org: null, orgProblems: ["организация не найдена"], groups: [], orders: [] };
    const docs = data.docs.filter(d => d.orgId === org.id && (d.status || "unpaid") === "unpaid");
    const g = groupBy(docs, d => digits(d.supplierInn));
    let no = Number(opts.startNo) || Number(org.nextNo) || 1;
    const groups = [], orders = [];
    const entries = [...g].sort((a, b) => ((supByInn(data, a[0]) || {}).name || "").localeCompare((supByInn(data, b[0]) || {}).name || ""));
    for (const [inn, items] of entries) {
      const sup = supByInn(data, inn);
      const probs = sup ? reqProblems(sup) : ["нет банковских реквизитов поставщика"];
      const on = items.filter(d => !off.has(d.id));
      const chunks = probs.length || !on.length ? [] : pack(on, sup).map(c => {
        const o = { no: no++, docs: c, amount: sum(c), purpose: purposeText(c, sup), sup };
        orders.push(o); return o;
      });
      groups.push({ inn, sup, items, probs, chunks });
    }
    return { org, orgProblems: reqProblems(org), groups, orders };
  }
  // Отмечает документы выгруженными и двигает нумерацию платёжек
  function markExported(data, plan, dateISO) {
    for (const o of plan.orders) for (const d of o.docs) {
      const doc = data.docs.find(x => x.id === d.id);
      if (doc) { doc.status = "bank"; doc.payNo = String(o.no); doc.exportedAt = dateISO; }
    }
    if (plan.orders.length) { const org = orgById(data, plan.org.id); org.nextNo = plan.orders[plan.orders.length - 1].no + 1; }
  }

  /* ---------- файл для банка ---------- */
  const MAP1251 = { 0x2116: 0xB9, 0xAB: 0xAB, 0xBB: 0xBB, 0x2014: 0x97, 0x2013: 0x96, 0xA0: 0x20, 0x2026: 0x85, 0x201C: 0x93, 0x201D: 0x94, 0x201E: 0x84, 0x2019: 0x92, 0x2018: 0x91, 0xA7: 0xA7, 0xB0: 0xB0 };
  function cp1251(str) {
    const out = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i); let b;
      if (c < 0x80) b = c; else if (c >= 0x410 && c <= 0x44F) b = c - 0x350; else if (c === 0x401) b = 0xA8; else if (c === 0x451) b = 0xB8; else b = MAP1251[c] ?? 0x3F;
      out[i] = b;
    }
    return out;
  }
  function build1C(org, orders, dateISO, now) {
    // Банк не принимает «ёлочки» и типографские кавычки — только прямые "
    const clean = s => String(s ?? "").replace(/[«»“”„]/g, "\"").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    now = now || new Date();
    const t = [now.getHours(), now.getMinutes(), now.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
    const L = ["1CClientBankExchange", "ВерсияФормата=1.03", "Кодировка=Windows", "Отправитель=Счета к оплате", "Получатель=",
      "ДатаСоздания=" + ru(iso(now)), "ВремяСоздания=" + t, "ДатаНачала=" + ru(dateISO), "ДатаКонца=" + ru(dateISO),
      "РасчСчет=" + digits(org.account), "Документ=Платежное поручение"];
    for (const o of orders) {
      const s = o.sup;
      L.push("СекцияДокумент=Платежное поручение", "Номер=" + o.no, "Дата=" + ru(dateISO), "Сумма=" + dot(o.amount),
        "ПлательщикСчет=" + digits(org.account), "Плательщик=" + clean(org.name), "ПлательщикИНН=" + digits(org.inn), "ПлательщикКПП=" + digits(org.kpp),
        "Плательщик1=" + clean(org.name), "ПлательщикРасчСчет=" + digits(org.account), "ПлательщикБанк1=" + clean(org.bank), "ПлательщикБанк2=" + clean(org.city),
        "ПлательщикБИК=" + digits(org.bik), "ПлательщикКорсчет=" + digits(org.corr),
        "ПолучательСчет=" + digits(s.account), "Получатель=" + clean(s.name), "ПолучательИНН=" + digits(s.inn), "ПолучательКПП=" + digits(s.kpp),
        "Получатель1=" + clean(s.name), "ПолучательРасчСчет=" + digits(s.account), "ПолучательБанк1=" + clean(s.bank), "ПолучательБанк2=" + clean(s.city),
        "ПолучательБИК=" + digits(s.bik), "ПолучательКорсчет=" + digits(s.corr),
        "ВидПлатежа=", "ВидОплаты=01", "Очередность=5", "НазначениеПлатежа=" + clean(o.purpose).slice(0, PURPOSE_MAX), "КонецДокумента");
    }
    L.push("КонецФайла");
    return L.join("\r\n") + "\r\n";
  }
  // Короткое имя для файла: «ООО «Ф.А. Логистик»» → «Ф.А. Логистик»
  function shortName(name) {
    let s = String(name || "").replace(/^\s*(ООО|АО|ПАО|ЗАО|ОАО|НАО|ИП|Индивидуальный предприниматель|Общество с ограниченной ответственностью)\s+/i, "");
    s = s.replace(/[«»"“”„]/g, "").replace(/[\\/:*?<>|\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
    return s.slice(0, 60).trim() || "Поставщик";
  }
  // Короткое имя своей организации: «ИП Гуцу Николай Валерьевич» → «Гуцу Н.В.», ООО — как shortName
  function orgShort(name) {
    const m = String(name || "").trim().match(/^(?:ИП|Индивидуальный предприниматель)\s+(\S+)\s+(\S)\S*\s+(\S)\S*/i);
    return m ? m[1] + " " + m[2] + "." + m[3] + "." : shortName(name);
  }
  // Имя файла для банка: «2026-10-15 Гуцу Н.В. - Ф.А. Логистик №245.txt», для нескольких платёжек «№245-246»
  function fileName(dateISO, sup, orders, org) {
    const nos = (orders || []).map(o => o.no);
    const no = !nos.length ? "" : " №" + (nos.length > 1 ? Math.min(...nos) + "-" + Math.max(...nos) : nos[0]);
    const payer = org && org.name ? orgShort(org.name).replace(/[\\/:*?"<>|]+/g, " ") + " - " : "";
    return dateISO + " " + payer + shortName(sup && sup.name || sup && sup.inn) + no + ".txt";
  }
  // Файлы для банка: по одному на поставщика, в порядке платёжек
  function exportFiles(org, orders, dateISO, now) {
    const g = groupBy(orders, o => digits(o.sup.inn));
    return [...g.values()].map(os => ({ name: fileName(dateISO, os[0].sup, os, org), sup: os[0].sup, orders: os, text: build1C(org, os, dateISO, now) }));
  }

  /* ---------- проверка всего файла данных ---------- */
  function checkData(data) {
    const issues = [];
    data.orgs.forEach(o => reqProblems(o).forEach(p => issues.push("Организация «" + o.name + "»: " + p)));
    data.suppliers.forEach(s => reqProblems(s).forEach(p => issues.push("Поставщик «" + (s.name || s.inn) + "»: " + p)));
    const seen = new Map();
    data.docs.forEach(d => {
      const tag = (TYPES[d.type] || "Документ") + " № " + d.number + (d.date ? " от " + ru(d.date) : "");
      if (!d.id) issues.push(tag + ": нет id");
      if (!orgById(data, d.orgId)) issues.push(tag + ": не указана организация-плательщик");
      if (!supByInn(data, d.supplierInn)) issues.push(tag + ": поставщика с ИНН " + d.supplierInn + " нет в справочнике");
      if (!d.amount) issues.push(tag + ": сумма 0");
      if (!validISO(d.date)) issues.push(tag + ": нет даты");
      if (d.vatRate && d.vatRate !== "none" && Math.abs(vatOf(d.amount, d.vatRate) - (d.vat || 0)) > 100) issues.push(tag + ": НДС не сходится со ставкой " + d.vatRate + "%");
      const k = digits(d.supplierInn) + "|" + String(d.number).trim() + "|" + d.date;
      if (seen.has(k)) issues.push(tag + ": дубль документа " + seen.get(k)); else seen.set(k, d.id);
    });
    const ids = new Set(); data.docs.forEach(d => { if (ids.has(d.id)) issues.push("Повторяется id " + d.id); ids.add(d.id); });
    return issues;
  }
  // Новый id документа: upd-7743666731-011026-3215
  const docId = d => [d.type || "doc", digits(d.supplierInn), String(d.number || "").trim()].join("-").replace(/[^A-Za-z0-9_.-]+/g, "_");

  /* ---------- слияние изменений с двух устройств ---------- */
  // Сравнение без учёта порядка ключей: утилиты и приложение пишут поля в разном порядке
  const canon = v => Array.isArray(v) ? "[" + v.map(canon).join(",") + "]"
    : v && typeof v === "object" ? "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}"
    : JSON.stringify(v);
  const same = (a, b) => canon(a) === canon(b);
  // Трёхстороннее слияние: base — версия, от которой начали правку; local — наша; remote — что сейчас на сервере.
  // Документы, поставщики и организации сливаются по ключу, внутри — по полям. Если одно поле поменяли
  // с обеих сторон по-разному — побеждает local (действие только что сделали на этом экране), nextNo — больший номер.
  function merge3(base, local, remote) {
    const conflicts = [];
    const mergeObj = (b, l, r, label) => {
      if (same(l, r)) return l;
      if (b === undefined) { if (l === undefined) return r; if (r === undefined) return l; }
      if (same(l, b)) return r;
      if (same(r, b)) return l;
      if (l === undefined || r === undefined) return l === undefined ? r : l;   // удалили с одной стороны, изменили с другой — оставляем
      const out = {};
      for (const k of new Set([...Object.keys(r), ...Object.keys(l)])) {
        const bv = b && b[k], lv = l[k], rv = r[k];
        if (same(lv, rv)) out[k] = lv;
        else if (same(lv, bv)) out[k] = rv;
        else if (same(rv, bv)) out[k] = lv;
        else if (k === "nextNo") out[k] = Math.max(Number(lv) || 0, Number(rv) || 0);
        else { out[k] = lv; conflicts.push(label + ": поле «" + k + "»"); }
      }
      for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
      return out;
    };
    const mergeList = (key, name, label) => {
      const idx = arr => new Map((arr || []).map(x => [key(x), x]));
      const B = idx(base[name]), L = idx(local[name]), R = idx(remote[name]);
      const order = [...R.keys(), ...[...L.keys()].filter(k => !R.has(k))];
      const out = [];
      for (const k of order) {
        const v = mergeObj(B.get(k), L.get(k), R.get(k), label(L.get(k) || R.get(k)));
        if (v !== undefined && !(B.has(k) && (!L.has(k) || !R.has(k)) && same(v, B.get(k)))) out.push(v);
      }
      return out;
    };
    const data = { ...remote, ...local };
    data.orgs = mergeList(o => o.id, "orgs", o => "Организация " + (o.name || o.id));
    data.suppliers = mergeList(s => digits(s.inn), "suppliers", s => "Поставщик " + (s.name || s.inn));
    data.docs = mergeList(d => d.id, "docs", d => "Документ " + (d.number || d.id));
    return { data, conflicts };
  }

  return {
    WD, MON, TYPES, SOURCES, VATS, DEFAULT_DAYS, PURPOSE_MAX,
    iso, today, D, ru, ruShort, human, diff, addDays, validISO,
    digits, kop, rub, rubIn, dot, vatOf, plural, sum, groupBy,
    innOk, accOk, corrOk, reqProblems,
    emptyData, orgById, supByInn, payDays, nextPay, stOf, dueOf, dueSource, openPrepays,
    autoPayNum, payNum, purposeText, pack, exportPlan, markExported,
    cp1251, build1C, shortName, orgShort, fileName, exportFiles, checkData, docId, merge3
  };
});
