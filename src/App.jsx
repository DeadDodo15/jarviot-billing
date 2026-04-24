import { useState, useEffect, useCallback, useRef } from "react";
import { auth, db } from "./firebase";
import { signInWithEmailAndPassword, onAuthStateChanged, signOut } from "firebase/auth";
import { doc, getDoc, setDoc } from "firebase/firestore";

/* ═══════════════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════════════ */
const P = "#7C5CFC";
const PL = "#F4F0FF";
const PD = "#5B3FD6";
const BG = "#F8FAFC";

const BILLED_BY = { name: "Jarviot Technologies", line1: "359, Ashirwad Villa, New City Light Road, Near ST Thomas School,", line2: "Surat,", line3: "Gujarat, India - 395007", gstin: "24AARFJ7238E1Z6", pan: "AARFJ7238E" };
const BILLED_TO = { name: "Molecule Ventures", line1: "B 904-906 Swastik Universal,", line2: "Surat,", line3: "Gujarat, India - 395007", gstin: "24ABPFM1322F1ZK", pan: "ABPFM1322F" };
const BANK = { name: "Jarviot Technologies", number: "50200118923721", ifsc: "HDFC0006022", type: "Current", bank: "HDFC Bank" };

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const FREQ = { monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

/* ═══════════════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════════════ */
function uid() { return "inv_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7); }
function addDays(d, n) { const x = new Date(d + "T00:00:00"); x.setDate(x.getDate() + n); return x.toISOString().split("T")[0]; }
function addMonths(d, n) { const x = new Date(d + "T00:00:00"); x.setMonth(x.getMonth() + n); return x.toISOString().split("T")[0]; }
function fmtDate(d) { if (!d) return ""; const x = new Date(d + "T00:00:00"); return x.toLocaleDateString("en-IN", { month: "short", day: "2-digit", year: "numeric" }); }
function fmtDateShort(d) { if (!d) return ""; const x = new Date(d + "T00:00:00"); return `${String(x.getDate()).padStart(2,"0")} ${MONTHS[x.getMonth()].slice(0,3)} ${x.getFullYear()}`; }
function fmt(n) { return Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function monthOf(d) { return MONTHS[new Date(d + "T00:00:00").getMonth()]; }
function yearOf(d) { return new Date(d + "T00:00:00").getFullYear(); }
function nextDate(d, freq) { if (freq === "quarterly") return addMonths(d, 3); if (freq === "yearly") return addMonths(d, 12); return addMonths(d, 1); }

function suggestInvoiceNo(date, invoices) {
  const m = monthOf(date), y = yearOf(date);
  const existing = invoices.filter(i => monthOf(i.invoiceDate) === m && yearOf(i.invoiceDate) === y);
  return `Mol/${m}/${String(existing.length + 1).padStart(2, "0")}`;
}

function numberToWordsINR(num) {
  if (!num || num === 0) return "ZERO RUPEES ONLY";
  const ones = ["","ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE","TEN","ELEVEN","TWELVE","THIRTEEN","FOURTEEN","FIFTEEN","SIXTEEN","SEVENTEEN","EIGHTEEN","NINETEEN"];
  const tens = ["","","TWENTY","THIRTY","FORTY","FIFTY","SIXTY","SEVENTY","EIGHTY","NINETY"];
  function c(n) {
    if (n === 0) return "";
    if (n < 20) return ones[n] + " ";
    if (n < 100) return tens[Math.floor(n/10)] + " " + (n%10 ? ones[n%10] + " " : "");
    if (n < 1000) return ones[Math.floor(n/100)] + " HUNDRED " + c(n%100);
    if (n < 100000) return c(Math.floor(n/1000)) + "THOUSAND " + c(n%1000);
    if (n < 10000000) return c(Math.floor(n/100000)) + "LAKH " + c(n%100000);
    return c(Math.floor(n/10000000)) + "CRORE " + c(n%10000000);
  }
  const r = Math.floor(num), p = Math.round((num - r) * 100);
  let s = c(r).trim() + " RUPEES";
  if (p > 0) s += " AND " + c(p).trim() + " PAISE";
  return s + " ONLY";
}

function computeItems(items) {
  return items.map(it => {
    const amount = (parseFloat(it.qty)||0) * (parseFloat(it.rate)||0);
    const g = parseFloat(it.gst)||0;
    const cgst = amount * g / 200, sgst = amount * g / 200;
    return { ...it, amount, cgst, sgst, total: amount + cgst + sgst };
  });
}

function computeTotals(ci) {
  return ci.reduce((a, i) => ({ amount: a.amount+i.amount, cgst: a.cgst+i.cgst, sgst: a.sgst+i.sgst, total: a.total+i.total }), { amount:0, cgst:0, sgst:0, total:0 });
}

function emptyItem() { return { id: uid(), description: "", hsn: "", gst: 18, qty: 1, rate: "" }; }

function emptyInvoice(invoices) {
  const today = new Date().toISOString().split("T")[0];
  return { id: uid(), invoiceNo: suggestInvoiceNo(today, invoices), invoiceDate: today, dueDate: addDays(today, 15), items: [emptyItem()], status: "draft", recurring: null, notes: "", createdAt: new Date().toISOString() };
}

function emptySubtask(text = "") {
  return { id: uid(), text, status: "open", createdAt: new Date().toISOString(), completedAt: null };
}

function emptyTask() {
  return {
    id: uid(),
    ticker: "-",
    text: "",
    kind: "",
    industry: "",
    dueDate: "",
    notes: "",
    status: "open",
    subtasks: [],
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

function emptyQuestion() {
  return {
    id: uid(),
    ticker: "-",
    text: "",
    kind: "",
    industry: "",
    dueDate: "",
    status: "open",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

function normalizeTask(t) {
  const rawSubs = Array.isArray(t?.subtasks) ? t.subtasks : [];
  return {
    id: t?.id || uid(),
    ticker: t?.ticker || "",
    text: t?.text || "",
    kind: t?.kind || "",
    industry: t?.industry || "",
    dueDate: t?.dueDate || "",
    notes: t?.notes || "",
    status: t?.status === "completed" ? "completed" : "open",
    subtasks: rawSubs.map(s => ({
      id: s?.id || uid(),
      text: s?.text || "",
      status: s?.status === "completed" ? "completed" : "open",
      createdAt: s?.createdAt || new Date().toISOString(),
      completedAt: s?.completedAt || null,
    })),
    createdAt: t?.createdAt || new Date().toISOString(),
    completedAt: t?.completedAt || null,
  };
}

function normalizeQuestion(q) {
  const status = ["open", "resolved", "stale"].includes(q?.status) ? q.status : "open";
  return {
    id: q?.id || uid(),
    ticker: q?.ticker || "",
    text: q?.text || "",
    kind: q?.kind || "",
    industry: q?.industry || "",
    dueDate: q?.dueDate || "",
    status,
    createdAt: q?.createdAt || new Date().toISOString(),
    resolvedAt: q?.resolvedAt || null,
  };
}

function normalizeTickerInput(nextValue, previousValue) {
  if (previousValue === "-" && nextValue.startsWith("-") && nextValue.length > 1) {
    return nextValue.slice(1);
  }
  return nextValue;
}

function finalizeTicker(value) {
  return value.trim().toUpperCase() || "-";
}

/* ───────── TRACKER helpers ───────── */
const ROUTINES = [
  { id: "announcements", label: "Corporate Announcements", freq: "daily" },
  { id: "bulk_deals",    label: "Bulk / Block Deals",      freq: "daily" },
  { id: "shareholding",  label: "Shareholding Changes",    freq: "daily" },
  { id: "sector_read",   label: "Sector Reading",          freq: "weekly" },
  { id: "portfolio_rev", label: "Portfolio Review",        freq: "weekly" },
];

function normalizeTracker(raw) {
  const logs = (raw?.routines?.logs && typeof raw.routines.logs === "object" && !Array.isArray(raw.routines.logs))
    ? raw.routines.logs : {};
  const seasons = Array.isArray(raw?.seasons)
    ? raw.seasons.map(s => ({
        id: s?.id || uid(),
        name: s?.name || "Unnamed Season",
        active: s?.active !== false,
        companies: Array.isArray(s?.companies) ? s.companies.map(c => ({
          id: c?.id || uid(),
          ticker: c?.ticker || "-",
          resultsRead: !!c?.resultsRead,
          concallRead: !!c?.concallRead,
          deckRead: !!c?.deckRead,
          date: c?.date || "",
          note: c?.note || "",
        })) : [],
      }))
    : [];
  return { routines: { logs }, seasons };
}

function normalizeData(raw) {
  const invoices = Array.isArray(raw?.invoices) ? raw.invoices : [];
  const tasksRaw = Array.isArray(raw?.todos?.tasks) ? raw.todos.tasks : [];
  const questionsRaw = Array.isArray(raw?.todos?.questions) ? raw.todos.questions : [];
  return {
    invoices,
    todos: {
      tasks: tasksRaw.map(normalizeTask),
      questions: questionsRaw.map(normalizeQuestion),
    },
    tracker: normalizeTracker(raw?.tracker),
  };
}

/* ═══════════════════════════════════════════════════════════════
   STORAGE — Firestore + localStorage fallback
   ═══════════════════════════════════════════════════════════════ */
const STORAGE_KEY = "jarviot-invoices";

function loadLocalData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? normalizeData(JSON.parse(raw)) : normalizeData({});
  } catch { return normalizeData({}); }
}

function saveLocalData(data) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch (e) { console.error("Save failed", e); }
}

async function loadFirestoreData(uid) {
  try {
    const snap = await getDoc(doc(db, "users", uid));
    if (snap.exists()) return normalizeData(snap.data());
    return normalizeData({});
  } catch (e) { console.error("Firestore load failed", e); return loadLocalData(); }
}

async function saveFirestoreData(uid, data) {
  saveLocalData(data); // always keep local copy
  try { await setDoc(doc(db, "users", uid), data); } catch (e) { console.error("Firestore save failed", e); }
}

function exportJSON(data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `jarviot-invoices-backup-${new Date().toISOString().split("T")[0]}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importJSON(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        const hasInvoices = Array.isArray(data?.invoices);
        const hasTasks = Array.isArray(data?.todos?.tasks);
        const hasQuestions = Array.isArray(data?.todos?.questions);
        if (!hasInvoices && !hasTasks && !hasQuestions) {
          reject(new Error("Invalid backup file"));
          return;
        }
        resolve(normalizeData(data));
      } catch { reject(new Error("Invalid JSON")); }
    };
    reader.onerror = () => reject(new Error("File read failed"));
    reader.readAsText(file);
  });
}

/* ═══════════════════════════════════════════════════════════════
   RECURRING CHECK
   ═══════════════════════════════════════════════════════════════ */
function processRecurring(data) {
  const today = new Date().toISOString().split("T")[0];
  let changed = false;
  const newInvoices = [];
  const updated = data.invoices.map(inv => {
    if (!inv.recurring?.active || !inv.recurring?.nextDate) return inv;
    if (inv.recurring.nextDate > today) return inv;
    changed = true;
    const nd = inv.recurring.nextDate;
    newInvoices.push({ id: uid(), invoiceNo: suggestInvoiceNo(nd, [...data.invoices, ...newInvoices]), invoiceDate: nd, dueDate: addDays(nd, 15), items: inv.items.map(it => ({ ...it, id: uid() })), status: "draft", recurring: null, parentId: inv.id, createdAt: new Date().toISOString() });
    return { ...inv, recurring: { ...inv.recurring, nextDate: nextDate(nd, inv.recurring.frequency), lastGenerated: today } };
  });
  if (!changed) return null;
  return { ...data, invoices: [...updated, ...newInvoices] };
}

/* ═══════════════════════════════════════════════════════════════
   PDF / PRINT — PIXEL-PERFECT
   ═══════════════════════════════════════════════════════════════ */
function generatePrintHTML(inv) {
  const ci = computeItems(inv.items), t = computeTotals(ci), hasHSN = ci.some(i => i.hsn);
  const rows = ci.map((it,i) => `<tr style="border-bottom:1px solid #e2e2e2"><td style="padding:10px 8px;text-align:center;font-size:13px">${i+1}.</td><td style="padding:10px 8px;text-align:left;font-size:13px">${it.description}</td>${hasHSN?`<td style="padding:10px 8px;text-align:center;font-size:13px">${it.hsn||""}</td>`:""}<td style="padding:10px 8px;text-align:center;font-size:13px">${it.gst}%</td><td style="padding:10px 8px;text-align:center;font-size:13px">${it.qty}</td><td style="padding:10px 8px;text-align:right;font-size:13px">₹${fmt(it.rate||0)}</td><td style="padding:10px 8px;text-align:right;font-size:13px">₹${fmt(it.amount)}</td><td style="padding:10px 8px;text-align:right;font-size:13px">₹${fmt(it.cgst)}</td><td style="padding:10px 8px;text-align:right;font-size:13px">₹${fmt(it.sgst)}</td><td style="padding:10px 8px;text-align:right;font-size:13px;font-weight:600">₹${fmt(it.total)}</td></tr>`).join("");

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice ${inv.invoiceNo}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Caveat:wght@600&display=swap" rel="stylesheet">
<style>@page{size:A4;margin:20mm 16mm 16mm 16mm}*{margin:0;padding:0;box-sizing:border-box}body{font-family:'DM Sans',sans-serif;color:#1a1a2e;font-size:13px;line-height:1.4}@media print{body{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}}</style></head><body><div style="max-width:770px;margin:0 auto">
<h1 style="font-size:30px;font-weight:700;color:${P};margin-bottom:12px">Invoice</h1>
<table style="margin-bottom:20px;font-size:13px"><tr><td style="color:#555;padding:2px 16px 2px 0;font-weight:600">Invoice No</td><td>${inv.invoiceNo}</td></tr><tr><td style="color:#555;padding:2px 16px 2px 0;font-weight:600">Invoice Date</td><td>${fmtDate(inv.invoiceDate)}</td></tr><tr><td style="color:#555;padding:2px 16px 2px 0;font-weight:600">Due Date</td><td>${fmtDate(inv.dueDate)}</td></tr></table>
<div style="display:flex;gap:20px;margin-bottom:20px">
<div style="flex:1;background:${PL};border-radius:6px;padding:16px"><div style="color:${P};font-weight:700;font-size:13px;margin-bottom:8px">Billed By</div><div style="font-weight:700;margin-bottom:4px">${BILLED_BY.name}</div><div style="font-size:12px;color:#555;line-height:1.6">${BILLED_BY.line1}<br>${BILLED_BY.line2}<br>${BILLED_BY.line3}</div><div style="font-size:12px;color:#555;margin-top:4px"><b>GSTIN:</b> ${BILLED_BY.gstin}</div><div style="font-size:12px;color:#555"><b>PAN:</b> ${BILLED_BY.pan}</div></div>
<div style="flex:1;background:${PL};border-radius:6px;padding:16px"><div style="color:${P};font-weight:700;font-size:13px;margin-bottom:8px">Billed To</div><div style="font-weight:700;margin-bottom:4px">${BILLED_TO.name}</div><div style="font-size:12px;color:#555;line-height:1.6">${BILLED_TO.line1}<br>${BILLED_TO.line2}<br>${BILLED_TO.line3}</div><div style="font-size:12px;color:#555;margin-top:4px"><b>GSTIN:</b> ${BILLED_TO.gstin}</div><div style="font-size:12px;color:#555"><b>PAN:</b> ${BILLED_TO.pan}</div></div></div>
<div style="display:flex;justify-content:space-between;font-size:12px;color:#666;padding:8px 0;border-bottom:1px solid #e2e2e2;margin-bottom:16px"><span>Country of Supply: India</span><span>Place of Supply: Gujarat (24)</span></div>
<table style="width:100%;border-collapse:collapse;margin-bottom:16px"><thead><tr style="background:${P}"><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:center;width:36px"></th><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:left">Item</th>${hasHSN?'<th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:center">HSN/SAC</th>':""}<th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:center;white-space:nowrap">GST<br>Rate</th><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:center">Quantity</th><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:right">Rate</th><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:right">Amount</th><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:right">CGST</th><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:right">SGST</th><th style="padding:10px 8px;color:#fff;font-size:12px;font-weight:600;text-align:right">Total</th></tr></thead><tbody>${rows}</tbody></table>
<div style="display:flex;gap:24px;margin-bottom:24px"><div style="flex:1;font-size:11.5px;color:#444;line-height:1.6;padding-top:4px"><b>Total (in words) :</b> ${numberToWordsINR(t.total)}</div><div style="width:280px"><div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #eee"><span>Amount</span><span>₹${fmt(t.amount)}</span></div><div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #eee"><span>CGST</span><span>₹${fmt(t.cgst)}</span></div><div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #eee"><span>SGST</span><span>₹${fmt(t.sgst)}</span></div><div style="display:flex;justify-content:space-between;padding:10px 0 0;font-size:16px;font-weight:700;border-top:2px solid ${P};margin-top:4px"><span>Total (INR)</span><span>₹${fmt(t.total)}</span></div></div></div>
<div style="display:flex;gap:24px;margin-bottom:24px"><div style="flex:1;background:${PL};border-radius:6px;padding:16px"><div style="color:${P};font-weight:700;font-size:12px;margin-bottom:10px">Bank Details</div><table style="font-size:12px"><tr><td style="color:#888;padding:2px 20px 2px 0;width:110px">Account Name</td><td style="font-weight:500">${BANK.name}</td></tr><tr><td style="color:#888;padding:2px 20px 2px 0">Account Number</td><td style="font-weight:500">${BANK.number}</td></tr><tr><td style="color:#888;padding:2px 20px 2px 0">IFSC</td><td style="font-weight:500">${BANK.ifsc}</td></tr><tr><td style="color:#888;padding:2px 20px 2px 0">Account Type</td><td style="font-weight:500">${BANK.type}</td></tr><tr><td style="color:#888;padding:2px 20px 2px 0">Bank</td><td style="font-weight:500">${BANK.bank}</td></tr></table></div><div style="width:200px;display:flex;flex-direction:column;align-items:flex-end;justify-content:flex-end"><div style="text-align:center"><div style="font-family:'Caveat',cursive;font-size:32px;color:#333;margin-bottom:2px">Pranjal</div><div style="border-top:1px solid #ccc;padding-top:6px;font-size:12px;color:#666">Partner</div></div></div></div>
<div style="border-top:1px solid #e2e2e2;padding-top:16px;margin-bottom:24px"><div style="color:${P};font-weight:700;font-size:13px;margin-bottom:8px">Terms and Conditions</div><div style="font-size:12px;color:#555;line-height:1.7">1. Please pay within 15 days from the date of invoice.<br>2. Please quote invoice number when remitting funds.</div></div>
<div style="border-top:2px dashed #ccc;padding-top:12px;display:flex;justify-content:space-between;font-size:11px;color:#888"><div><b>Invoice No</b><br>${inv.invoiceNo}</div><div><b>Invoice Date</b><br>${fmtDateShort(inv.invoiceDate)}</div><div><b>Billed To</b><br>${BILLED_TO.name}</div><div style="text-align:right">Page 1 of 1</div></div>
</div></body></html>`;
}

function downloadPDF(inv) {
  const html = generatePrintHTML(inv);
  const w = window.open("", "_blank");
  if (!w) { alert("Allow popups to download PDF"); return; }
  w.document.write(html); w.document.close();
  setTimeout(() => w.print(), 500);
}

/* ═══════════════════════════════════════════════════════════════
   STYLES
   ═══════════════════════════════════════════════════════════════ */
const css = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Caveat:wght@600&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
html,body,#root{height:100%}
.app{display:flex;height:100vh;background:${BG};color:#1a1a2e;font-family:'DM Sans',sans-serif}
.sb{width:220px;background:#fff;border-right:1px solid #E2E8F0;display:flex;flex-direction:column;padding:20px 0;flex-shrink:0;transition:transform .25s ease}
.sb-title{font-size:15px;font-weight:700;color:${P};padding:0 20px;margin-bottom:20px;letter-spacing:-0.3px}
.sb-item{display:flex;align-items:center;gap:10px;padding:9px 20px;font-size:13px;font-weight:500;color:#64748B;cursor:pointer;border-left:3px solid transparent;transition:all .15s;user-select:none}
.sb-item:hover{background:${PL};color:${P}}
.sb-item.active{background:${PL};color:${P};border-left-color:${P};font-weight:600}
.sb-new{margin:16px 16px 0;padding:10px;border-radius:8px;background:${P};color:#fff;font-size:13px;font-weight:600;border:none;cursor:pointer;font-family:inherit;transition:background .15s}
.sb-new:hover{background:${PD}}
.main{flex:1;overflow-y:auto;padding:28px 32px}
.page-title{font-size:22px;font-weight:700;margin-bottom:4px}
.page-sub{font-size:13px;color:#94A3B8;margin-bottom:24px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:28px}
.card{background:#fff;border-radius:10px;padding:18px;border:1px solid #E2E8F0}
.card-label{font-size:11px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.card-val{font-size:22px;font-weight:700}
.tbl-wrap{width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch;border-radius:10px;border:1px solid #E2E8F0;background:#fff}
.tbl{width:100%;border-collapse:collapse;font-size:13px;background:#fff;border-radius:10px;overflow:hidden;border:none;min-width:600px}
.tbl th{padding:10px 12px;font-size:11px;font-weight:600;color:#94A3B8;text-transform:uppercase;letter-spacing:.4px;text-align:left;border-bottom:1px solid #E2E8F0;background:#FAFBFC}
.tbl td{padding:12px;border-bottom:1px solid #F1F5F9}
.tbl tr:last-child td{border-bottom:none}
.tbl tr:hover td{background:#FAFBFC}
.label{font-size:11px;font-weight:600;color:#64748B;text-transform:uppercase;letter-spacing:.4px;margin-bottom:5px;display:block}
.inp{border:1px solid #D0D5DD;border-radius:7px;padding:8px 12px;font-size:13px;font-family:inherit;width:100%;outline:none;transition:border .15s,box-shadow .15s;background:#fff}
.inp:focus{border-color:${P};box-shadow:0 0 0 3px rgba(124,92,252,.1)}
.inp[readonly]{background:#F8FAFC;color:#94A3B8}
.btn{padding:8px 18px;border-radius:7px;font-size:13px;font-weight:600;cursor:pointer;border:none;font-family:inherit;transition:all .12s;display:inline-flex;align-items:center;gap:6px}
.btn-p{background:${P};color:#fff}.btn-p:hover{background:${PD}}
.btn-s{background:${PL};color:${P}}.btn-s:hover{background:#EBE5FF}
.btn-o{background:#fff;color:#64748B;border:1px solid #D0D5DD}.btn-o:hover{background:#F8FAFC}
.btn-d{background:none;color:#EF4444;border:1px solid #FECACA;padding:6px 10px;font-size:12px}.btn-d:hover{background:#FEF2F2}
.btn-g{background:#10B981;color:#fff}.btn-g:hover{background:#059669}
.badge{display:inline-block;padding:3px 10px;border-radius:99px;font-size:11px;font-weight:600}
.badge-draft{background:#FEF3C7;color:#92400E}
.badge-finalized{background:#DBEAFE;color:#1E40AF}
.badge-paid{background:#D1FAE5;color:#065F46}
.badge-recurring{background:#EDE9FE;color:#6D28D9}
.folder-year{font-size:15px;font-weight:700;margin:16px 0 8px;display:flex;align-items:center;gap:8px;cursor:pointer}
.folder-month{font-size:13px;font-weight:600;color:${P};margin:10px 0 6px 24px;display:flex;align-items:center;gap:6px}
.folder-inv{margin-left:48px;padding:8px 14px;background:#fff;border:1px solid #E2E8F0;border-radius:8px;margin-bottom:6px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:13px;transition:border .15s}
.folder-inv:hover{border-color:${P}}
.rec-box{background:${PL};border-radius:10px;padding:16px;margin-top:8px}
.toggle{width:40px;height:22px;border-radius:11px;background:#D0D5DD;position:relative;cursor:pointer;transition:background .2s;flex-shrink:0}
.toggle.on{background:${P}}
.toggle::after{content:'';position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;transition:transform .2s;box-shadow:0 1px 3px rgba(0,0,0,.15)}
.toggle.on::after{transform:translateX(18px)}
.mobile-header{display:none;position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid #E2E8F0;padding:12px 16px;align-items:center;justify-content:space-between}
.hamburger{background:none;border:none;font-size:22px;cursor:pointer;padding:4px 8px;color:#64748B}
.sb-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.3);z-index:199}
.todo-split{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.todo-form-grid{display:grid;gap:10px;margin-bottom:10px}
.todo-form-grid.tasks{grid-template-columns:1fr 2fr 1fr 1fr 1fr}
.todo-form-grid.questions{grid-template-columns:1fr 2fr 1fr 1fr 1fr 1fr}
.subtask-panel{background:#F8FAFC;border-top:1px solid #E2E8F0;padding:12px 16px}
.subtask-item{display:flex;align-items:center;gap:8px;padding:5px 0;border-bottom:1px solid #F1F5F9}
.subtask-item:last-of-type{border-bottom:none}
.subtask-check{width:16px;height:16px;accent-color:${P};cursor:pointer;flex-shrink:0}
.subtask-text{font-size:13px;flex:1;color:#1a1a2e}
.subtask-text.done{text-decoration:line-through;color:#94A3B8}
.subtask-add{display:flex;gap:8px;margin-top:10px}
.subtask-progress{display:inline-flex;align-items:center;gap:4px;background:#EDE9FE;color:#6D28D9;border-radius:99px;font-size:11px;font-weight:700;padding:2px 8px;margin-left:6px}
@media(max-width:768px){
  .app{flex-direction:column;height:auto;min-height:100vh}
  .mobile-header{display:flex}
  .sb{position:fixed;top:0;left:0;bottom:0;z-index:200;transform:translateX(-100%);width:260px;padding-top:20px;box-shadow:4px 0 24px rgba(0,0,0,.12)}
  .sb.open{transform:translateX(0)}
  .sb-overlay.open{display:block}
  .main{padding:16px;padding-top:8px}
  .page-title{font-size:18px}
  .cards{grid-template-columns:repeat(2,1fr);gap:10px}
  .card{padding:14px}
  .card-val{font-size:18px}
  .form-header{flex-direction:column;gap:12px;align-items:stretch!important}
  .form-header .btn{width:100%;justify-content:center}
  .form-meta{grid-template-columns:1fr!important}
  .form-bottom{grid-template-columns:1fr!important}
  .preview-actions{flex-wrap:wrap}
  .preview-box{padding:20px 16px!important}
  .preview-parties{grid-template-columns:1fr!important}
  .preview-summary{flex-direction:column}
  .preview-bank{flex-direction:column}
  .folder-inv{margin-left:24px}
  .folder-month{margin-left:12px}
  .todo-split{grid-template-columns:1fr}
  .todo-form-grid.tasks{grid-template-columns:1fr}
  .todo-form-grid.questions{grid-template-columns:1fr}
}
@media(max-width:480px){
  .cards{grid-template-columns:1fr 1fr;gap:8px}
  .btn{padding:7px 12px;font-size:12px}
  .todo-actions .btn{flex:1;justify-content:center}
}
`;

/* ═══════════════════════════════════════════════════════════════
   LOGIN SCREEN
   ═══════════════════════════════════════════════════════════════ */
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError(err.code === "auth/invalid-credential" ? "Invalid email or password" : err.message);
    }
    setLoading(false);
  };

  return (
    <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:BG,fontFamily:"'DM Sans',sans-serif"}}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');`}</style>
      <div style={{background:"#fff",borderRadius:16,padding:"48px 40px",width:"100%",maxWidth:380,margin:"0 16px",boxShadow:"0 4px 24px rgba(0,0,0,0.08)"}}>
        <div style={{textAlign:"center",marginBottom:32}}>
          <div style={{fontSize:28,fontWeight:700,color:P,marginBottom:4}}>⬡ Jarviot Invoices</div>
          <div style={{fontSize:13,color:"#94A3B8"}}>Sign in to continue</div>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{marginBottom:16}}>
            <label style={{fontSize:11,fontWeight:600,color:"#64748B",textTransform:"uppercase",letterSpacing:".4px",display:"block",marginBottom:5}}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              style={{border:"1px solid #D0D5DD",borderRadius:7,padding:"10px 12px",fontSize:14,fontFamily:"inherit",width:"100%",outline:"none",boxSizing:"border-box"}} />
          </div>
          <div style={{marginBottom:20}}>
            <label style={{fontSize:11,fontWeight:600,color:"#64748B",textTransform:"uppercase",letterSpacing:".4px",display:"block",marginBottom:5}}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              style={{border:"1px solid #D0D5DD",borderRadius:7,padding:"10px 12px",fontSize:14,fontFamily:"inherit",width:"100%",outline:"none",boxSizing:"border-box"}} />
          </div>
          {error && <div style={{color:"#EF4444",fontSize:12,marginBottom:12,textAlign:"center"}}>{error}</div>}
          <button type="submit" disabled={loading}
            style={{width:"100%",padding:"11px",borderRadius:8,background:P,color:"#fff",fontSize:14,fontWeight:600,border:"none",cursor:loading?"not-allowed":"pointer",fontFamily:"inherit",opacity:loading?.7:1}}>
            {loading ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   MAIN APP
   ═══════════════════════════════════════════════════════════════ */
export default function InvoiceApp() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out
  const [data, setData] = useState(normalizeData({}));
  const [section, setSection] = useState("billing");
  const [view, setView] = useState("billing-dashboard");
  const [editInv, setEditInv] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const fileRef = useRef(null);

  // Auth listener
  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u ?? null));
    return unsub;
  }, []);

  // Load data when user signs in
  useEffect(() => {
    if (!user) { setLoaded(false); return; }
    loadFirestoreData(user.uid).then(d => {
      const processed = processRecurring(d);
      if (processed) { saveFirestoreData(user.uid, processed); setData(processed); }
      else setData(d);
      setLoaded(true);
    });
  }, [user]);

  const save = useCallback((d) => {
    const normalized = normalizeData(d);
    setData(normalized);
    if (user) saveFirestoreData(user.uid, normalized);
  }, [user]);

  const goCreate = () => { setSection("billing"); setEditInv(emptyInvoice(data.invoices)); setView("billing-form"); };
  const goEdit = (inv) => { setSection("billing"); setEditInv({ ...inv, items: inv.items.map(i => ({...i})) }); setView("billing-form"); };
  const goPreview = (inv) => { setSection("billing"); setEditInv(inv); setView("billing-preview"); };

  const saveInvoice = (inv) => {
    const exists = data.invoices.find(i => i.id === inv.id);
    const newInvoices = exists ? data.invoices.map(i => i.id === inv.id ? inv : i) : [...data.invoices, inv];
    save({ ...data, invoices: newInvoices });
    setView("billing-list");
  };

  const deleteInvoice = (id) => { save({ ...data, invoices: data.invoices.filter(i => i.id !== id) }); if (view==="billing-preview") setView("billing-list"); };
  const markPaid = (id) => { save({ ...data, invoices: data.invoices.map(i => i.id === id ? {...i, status:"paid"} : i) }); };

  const saveTask = (task) => {
    const normalized = normalizeTask(task);
    const exists = data.todos.tasks.find(t => t.id === normalized.id);
    const tasks = exists
      ? data.todos.tasks.map(t => t.id === normalized.id ? normalized : t)
      : [normalized, ...data.todos.tasks];
    save({ ...data, todos: { ...data.todos, tasks } });
  };

  const toggleTask = (id) => {
    const tasks = data.todos.tasks.map(t => {
      if (t.id !== id) return t;
      const completed = t.status !== "completed";
      return { ...t, status: completed ? "completed" : "open", completedAt: completed ? new Date().toISOString() : null };
    });
    save({ ...data, todos: { ...data.todos, tasks } });
  };

  const deleteTask = (id) => {
    save({ ...data, todos: { ...data.todos, tasks: data.todos.tasks.filter(t => t.id !== id) } });
  };

  const saveQuestion = (question) => {
    const normalized = normalizeQuestion(question);
    const exists = data.todos.questions.find(q => q.id === normalized.id);
    const questions = exists
      ? data.todos.questions.map(q => q.id === normalized.id ? normalized : q)
      : [normalized, ...data.todos.questions];
    save({ ...data, todos: { ...data.todos, questions } });
  };

  const setQuestionStatus = (id, status) => {
    const questions = data.todos.questions.map(q => q.id !== id ? q : {
      ...q,
      status,
      resolvedAt: status === "resolved" ? new Date().toISOString() : null,
    });
    save({ ...data, todos: { ...data.todos, questions } });
  };

  const deleteQuestion = (id) => {
    save({ ...data, todos: { ...data.todos, questions: data.todos.questions.filter(q => q.id !== id) } });
  };

  const saveTracker = (tracker) => {
    save({ ...data, tracker: normalizeTracker(tracker) });
  };

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const imported = await importJSON(file);
      save(imported);
      alert(`Imported ${imported.invoices.length} invoices, ${imported.todos.tasks.length} tasks, and ${imported.todos.questions.length} questions.`);
    } catch (err) { alert("Import failed: " + err.message); }
    e.target.value = "";
  };

  const handleLogout = async () => {
    await signOut(auth);
    setSection("billing");
    setView("billing-dashboard");
  };

  const billingNav = [["billing-dashboard","◫","Dashboard"],["billing-list","☰","All Invoices"],["billing-folder","⊞","Folder"],["billing-recurring","↻","Recurring"]];
  const todoNav = [["todo-dashboard","◫","Overview"],["todo-tasks","✓","Tasks"],["todo-questions","?","Questions"],["todo-tracker","⬡","Tracker"]];

  // Loading state
  if (user === undefined) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:BG,fontFamily:"'DM Sans',sans-serif",color:"#94A3B8"}}>Loading...</div>;

  // Login gate
  if (!user) return <LoginScreen />;

  // Wait for Firestore data
  if (!loaded) return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:BG,fontFamily:"'DM Sans',sans-serif",color:"#94A3B8"}}>Loading invoices...</div>;

  return (
    <div className="app"><style>{css}</style>
      <div className="mobile-header">
        <button className="hamburger" onClick={() => setSidebarOpen(true)}>☰</button>
        <span style={{fontWeight:700,color:P,fontSize:15}}>⬡ Jarviot Workspace</span>
        <span style={{width:36}}></span>
      </div>
      <div className={`sb-overlay ${sidebarOpen?"open":""}`} onClick={() => setSidebarOpen(false)} />
      <div className={`sb ${sidebarOpen?"open":""}`}>
        <div className="sb-title">⬡ Jarviot Workspace</div>
        <div style={{display:"flex",gap:8,padding:"0 16px",marginBottom:14}}>
          <button className={`btn ${section==="billing"?"btn-p":"btn-o"}`} style={{flex:1,justifyContent:"center",padding:"7px 8px",fontSize:12}} onClick={() => { setSection("billing"); setView("billing-dashboard"); setSidebarOpen(false); }}>Billing</button>
          <button className={`btn ${section==="todo"?"btn-p":"btn-o"}`} style={{flex:1,justifyContent:"center",padding:"7px 8px",fontSize:12}} onClick={() => { setSection("todo"); setView("todo-dashboard"); setSidebarOpen(false); }}>Todo</button>
        </div>
        {(section === "billing" ? billingNav : todoNav).map(([v,ico,label]) => (
          <div key={v} className={`sb-item ${view===v?"active":""}`} onClick={() => { setView(v); setSidebarOpen(false); }}><span style={{fontSize:16,width:20,textAlign:"center"}}>{ico}</span>{label}</div>
        ))}
        <button className="sb-new" onClick={() => {
          if (section === "billing") goCreate();
          else { setView("todo-tasks"); setSidebarOpen(false); }
        }}>{section === "billing" ? "+ New Invoice" : "+ Add Task"}</button>
        <div style={{marginTop:"auto",padding:"0 16px",display:"flex",flexDirection:"column",gap:8}}>
          <button className="btn btn-s" style={{width:"100%",justifyContent:"center"}} onClick={() => exportJSON(data)}>↓ Export JSON</button>
          <button className="btn btn-s" style={{width:"100%",justifyContent:"center"}} onClick={() => fileRef.current?.click()}>↑ Import JSON</button>
          <input ref={fileRef} type="file" accept=".json" style={{display:"none"}} onChange={handleImport} />
          <div style={{fontSize:11,color:"#94A3B8",textAlign:"center",padding:"4px 0",borderTop:"1px solid #E2E8F0",marginTop:4}}>{user.email}</div>
          <button className="btn btn-o" style={{width:"100%",justifyContent:"center",fontSize:12}} onClick={handleLogout}>Sign Out</button>
        </div>
      </div>
      <div className="main">
        {view === "billing-dashboard" && <Dashboard data={data} goPreview={goPreview} goEdit={goEdit} goCreate={goCreate} />}
        {view === "billing-list" && <InvList data={data} goPreview={goPreview} goEdit={goEdit} markPaid={markPaid} deleteInvoice={deleteInvoice} />}
        {view === "billing-folder" && <FolderView data={data} goPreview={goPreview} />}
        {view === "billing-recurring" && <RecurringView data={data} goPreview={goPreview} goEdit={goEdit} />}
        {view === "billing-form" && editInv && <InvForm inv={editInv} onSave={saveInvoice} onCancel={() => setView("billing-list")} allInvoices={data.invoices} />}
        {view === "billing-preview" && editInv && <Preview inv={editInv} onBack={() => setView("billing-list")} onEdit={() => goEdit(editInv)} onDelete={() => deleteInvoice(editInv.id)} />}
        {view === "todo-dashboard" && <TodoDashboard todos={data.todos} />}
        {view === "todo-tasks" && <TodoTasks tasks={data.todos.tasks} onSaveTask={saveTask} onToggleTask={toggleTask} onDeleteTask={deleteTask} />}
        {view === "todo-questions" && <TodoQuestions questions={data.todos.questions} onSaveQuestion={saveQuestion} onSetQuestionStatus={setQuestionStatus} onDeleteQuestion={deleteQuestion} />}
        {view === "todo-tracker" && <Tracker tracker={data.tracker} onSave={saveTracker} />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
function Dashboard({ data, goPreview, goEdit, goCreate }) {
  const now = new Date();
  const thisMonth = data.invoices.filter(i => { const d = new Date(i.invoiceDate+"T00:00:00"); return d.getMonth()===now.getMonth() && d.getFullYear()===now.getFullYear(); });
  const drafts = data.invoices.filter(i => i.status==="draft");
  const totalThisMonth = thisMonth.reduce((s,i) => s + computeTotals(computeItems(i.items)).total, 0);
  const recurring = data.invoices.filter(i => i.recurring?.active);

  return (<>
    <div className="page-title">Dashboard</div>
    <div className="page-sub">{fmtDate(new Date().toISOString().split("T")[0])}</div>
    <div className="cards">
      <div className="card"><div className="card-label">Total Invoices</div><div className="card-val">{data.invoices.length}</div></div>
      <div className="card"><div className="card-label">This Month</div><div className="card-val" style={{color:P}}>₹{fmt(totalThisMonth)}</div></div>
      <div className="card"><div className="card-label">Drafts</div><div className="card-val" style={{color:"#F59E0B"}}>{drafts.length}</div></div>
      <div className="card"><div className="card-label">Recurring</div><div className="card-val" style={{color:"#8B5CF6"}}>{recurring.length}</div></div>
    </div>

    {drafts.length > 0 && <>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Pending Drafts</div>
      <div className="tbl-wrap" style={{marginBottom:24}}><table className="tbl"><thead><tr><th>Invoice No</th><th>Date</th><th style={{textAlign:"right"}}>Amount</th><th>Actions</th></tr></thead>
      <tbody>{drafts.map(i => { const tot = computeTotals(computeItems(i.items)).total; return <tr key={i.id}><td style={{fontWeight:600}}>{i.invoiceNo}</td><td>{fmtDate(i.invoiceDate)}</td><td style={{textAlign:"right"}}>₹{fmt(tot)}</td><td><button className="btn btn-s" style={{marginRight:6}} onClick={() => goEdit(i)}>Edit</button><button className="btn btn-o" onClick={() => goPreview(i)}>View</button></td></tr>; })}</tbody></table></div>
    </>}

    {data.invoices.length === 0 && <div style={{textAlign:"center",padding:"60px 0",color:"#94A3B8"}}><div style={{fontSize:48,marginBottom:12}}>📄</div><div style={{fontSize:15,fontWeight:600,marginBottom:8}}>No invoices yet</div><button className="btn btn-p" onClick={goCreate}>Create your first invoice</button></div>}

    {data.invoices.length > 0 && <>
      <div style={{fontSize:15,fontWeight:700,marginBottom:12}}>Recent Invoices</div>
      <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Invoice No</th><th>Date</th><th style={{textAlign:"right"}}>Total</th><th>Status</th><th></th></tr></thead>
      <tbody>{[...data.invoices].sort((a,b) => b.invoiceDate.localeCompare(a.invoiceDate)).slice(0,5).map(i => { const tot = computeTotals(computeItems(i.items)).total; return <tr key={i.id}><td style={{fontWeight:600}}>{i.invoiceNo}</td><td>{fmtDate(i.invoiceDate)}</td><td style={{textAlign:"right"}}>₹{fmt(tot)}</td><td><span className={`badge badge-${i.status}`}>{i.status}</span>{i.recurring?.active && <span className="badge badge-recurring" style={{marginLeft:6}}>↻</span>}</td><td><button className="btn btn-o" onClick={() => goPreview(i)}>View</button></td></tr>; })}</tbody></table></div>
    </>}
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   INVOICE LIST
   ═══════════════════════════════════════════════════════════════ */
function InvList({ data, goPreview, goEdit, markPaid, deleteInvoice }) {
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const sorted = [...data.invoices].sort((a,b) => b.invoiceDate.localeCompare(a.invoiceDate));
  const byStatus = filter === "all" ? sorted : sorted.filter(i => i.status === filter);
  const filtered = !search.trim() ? byStatus : byStatus.filter(i => {
    const q = search.toLowerCase();
    const tot = computeTotals(computeItems(i.items)).total;
    return i.invoiceNo.toLowerCase().includes(q)
      || fmt(tot).includes(q)
      || String(Math.round(tot)).includes(q)
      || i.items.some(it => it.description?.toLowerCase().includes(q))
      || (i.notes || "").toLowerCase().includes(q);
  });

  return (<>
    <div className="page-title">All Invoices</div>
    <div style={{display:"flex",gap:12,marginBottom:20,flexWrap:"wrap",alignItems:"center"}}>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{["all","draft","finalized","paid"].map(f => <button key={f} className={`btn ${filter===f?"btn-p":"btn-o"}`} onClick={() => setFilter(f)} style={{textTransform:"capitalize"}}>{f}</button>)}</div>
      <div style={{flex:1,minWidth:200,maxWidth:320,position:"relative"}}>
        <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:"#94A3B8",fontSize:14,pointerEvents:"none"}}>⌕</span>
        <input className="inp" placeholder="Search invoices..." value={search} onChange={e => setSearch(e.target.value)} style={{paddingLeft:30}} />
      </div>
    </div>
    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Invoice No</th><th>Date</th><th>Due Date</th><th style={{textAlign:"right"}}>Total</th><th>Status</th><th>Actions</th></tr></thead>
    <tbody>{filtered.length === 0 ? <tr><td colSpan={6} style={{textAlign:"center",padding:40,color:"#94A3B8"}}>{search ? "No invoices match your search" : "No invoices found"}</td></tr> :
      filtered.map(i => { const tot = computeTotals(computeItems(i.items)).total; return <tr key={i.id}>
        <td style={{fontWeight:600}}>{i.invoiceNo}</td><td>{fmtDate(i.invoiceDate)}</td><td>{fmtDate(i.dueDate)}</td><td style={{textAlign:"right",fontWeight:600}}>₹{fmt(tot)}</td>
        <td><span className={`badge badge-${i.status}`}>{i.status}</span>{i.recurring?.active && <span className="badge badge-recurring" style={{marginLeft:6}}>↻</span>}</td>
        <td style={{whiteSpace:"nowrap"}}><button className="btn btn-o" style={{marginRight:6}} onClick={() => goPreview(i)}>View</button><button className="btn btn-s" style={{marginRight:6}} onClick={() => goEdit(i)}>Edit</button>{i.status==="finalized" && <button className="btn btn-g" style={{fontSize:12,padding:"5px 10px",marginRight:6}} onClick={() => markPaid(i.id)}>Paid</button>}<button className="btn btn-d" onClick={() => { if(confirm("Delete this invoice?")) deleteInvoice(i.id); }}>✕</button></td>
      </tr>; })}</tbody></table></div>
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   FOLDER VIEW
   ═══════════════════════════════════════════════════════════════ */
function FolderView({ data, goPreview }) {
  const grouped = {};
  data.invoices.forEach(i => { const y = yearOf(i.invoiceDate), m = monthOf(i.invoiceDate); if (!grouped[y]) grouped[y] = {}; if (!grouped[y][m]) grouped[y][m] = []; grouped[y][m].push(i); });
  const years = Object.keys(grouped).sort((a,b) => b-a);
  return (<>
    <div className="page-title">Folder</div><div className="page-sub">Browse invoices by month</div>
    {years.length === 0 && <div style={{color:"#94A3B8",textAlign:"center",padding:60}}>No invoices yet</div>}
    {years.map(y => <div key={y}><div className="folder-year">📁 {y}</div>
      {MONTHS.filter(m => grouped[y]?.[m]).map(m => <div key={m}><div className="folder-month">📂 {m}</div>
        {grouped[y][m].sort((a,b) => a.invoiceNo.localeCompare(b.invoiceNo)).map(i => { const tot = computeTotals(computeItems(i.items)).total; return <div key={i.id} className="folder-inv" onClick={() => goPreview(i)}><div><span style={{fontWeight:600}}>{i.invoiceNo}</span><span className={`badge badge-${i.status}`} style={{marginLeft:10}}>{i.status}</span></div><div style={{fontWeight:600,color:P}}>₹{fmt(tot)}</div></div>; })}
      </div>)}</div>)}
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   RECURRING VIEW
   ═══════════════════════════════════════════════════════════════ */
function RecurringView({ data, goPreview, goEdit }) {
  const rec = data.invoices.filter(i => i.recurring?.active);
  return (<>
    <div className="page-title">Recurring Invoices</div><div className="page-sub">Templates that auto-generate invoices on schedule</div>
    {rec.length === 0 && <div style={{color:"#94A3B8",textAlign:"center",padding:60}}>No recurring invoices. Toggle recurrence when creating or editing an invoice.</div>}
    <div style={{display:"grid",gap:12}}>{rec.map(i => { const tot = computeTotals(computeItems(i.items)).total; return <div key={i.id} className="card" style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{fontWeight:700,marginBottom:4}}>{i.invoiceNo} <span className="badge badge-recurring" style={{marginLeft:6}}>↻ {FREQ[i.recurring.frequency]}</span></div><div style={{fontSize:12,color:"#94A3B8"}}>Next: {fmtDate(i.recurring.nextDate)} · ₹{fmt(tot)}</div></div>
      <div style={{display:"flex",gap:8}}><button className="btn btn-o" onClick={() => goPreview(i)}>View</button><button className="btn btn-s" onClick={() => goEdit(i)}>Edit</button></div>
    </div>; })}</div>
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   TODO DASHBOARD
   ═══════════════════════════════════════════════════════════════ */
function TodoDashboard({ todos }) {
  const today = new Date().toISOString().split("T")[0];
  const openTasks = todos.tasks.filter(t => t.status !== "completed");
  const overdueTasks = openTasks.filter(t => t.dueDate && t.dueDate < today);
  const openQuestions = todos.questions.filter(q => q.status === "open");
  const staleQuestions = todos.questions.filter(q => q.status === "stale");

  const recentTasks = [...todos.tasks].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 5);
  const recentQuestions = [...todos.questions].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || "")).slice(0, 5);

  return (<>
    <div className="page-title">Todo Overview</div>
    <div className="page-sub">Low-friction capture for tasks and research questions</div>

    <div className="cards">
      <div className="card"><div className="card-label">Open Tasks</div><div className="card-val">{openTasks.length}</div></div>
      <div className="card"><div className="card-label">Overdue Tasks</div><div className="card-val" style={{color:"#DC2626"}}>{overdueTasks.length}</div></div>
      <div className="card"><div className="card-label">Open Questions</div><div className="card-val" style={{color:P}}>{openQuestions.length}</div></div>
      <div className="card"><div className="card-label">Stale Questions</div><div className="card-val" style={{color:"#B45309"}}>{staleQuestions.length}</div></div>
    </div>

    <div className="todo-split">
      <div className="card" style={{padding:0}}>
        <div style={{padding:"14px 16px",borderBottom:"1px solid #E2E8F0",fontWeight:700}}>Recent Tasks</div>
        {recentTasks.length === 0 ? <div style={{padding:16,color:"#94A3B8",fontSize:13}}>No tasks yet</div> : recentTasks.map(t => (
          <div key={t.id} style={{padding:"12px 16px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontWeight:600,fontSize:13}}>{t.ticker || "-"} - {t.text}</div>
            <div style={{fontSize:12,color:"#94A3B8",marginTop:2}}>{t.kind || "no kind"}{t.dueDate ? ` · due ${fmtDate(t.dueDate)}` : ""}{t.status === "completed" ? " · completed" : ""}</div>
          </div>
        ))}
      </div>
      <div className="card" style={{padding:0}}>
        <div style={{padding:"14px 16px",borderBottom:"1px solid #E2E8F0",fontWeight:700}}>Recent Questions</div>
        {recentQuestions.length === 0 ? <div style={{padding:16,color:"#94A3B8",fontSize:13}}>No questions yet</div> : recentQuestions.map(q => (
          <div key={q.id} style={{padding:"12px 16px",borderBottom:"1px solid #F1F5F9"}}>
            <div style={{fontWeight:600,fontSize:13}}>{q.ticker || "-"} - {q.text}</div>
            <div style={{fontSize:12,color:"#94A3B8",marginTop:2}}>{q.kind || "no kind"} · {q.status}{q.dueDate ? ` · due ${fmtDate(q.dueDate)}` : ""}</div>
          </div>
        ))}
      </div>
    </div>
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   TODO TASKS
   ═══════════════════════════════════════════════════════════════ */
function TodoTasks({ tasks, onSaveTask, onToggleTask, onDeleteTask }) {
  const [form, setForm] = useState(emptyTask());
  const [editingId, setEditingId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [subtaskInputs, setSubtaskInputs] = useState({}); // taskId → text
  const [filter, setFilter] = useState("open");
  const [tickerFilter, setTickerFilter] = useState("");
  const [kindFilter, setKindFilter] = useState("");
  const [industryFilter, setIndustryFilter] = useState("");
  const formRef = useRef(null);

  const kinds = Array.from(new Set(tasks.map(t => (t.kind || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const industries = Array.from(new Set(tasks.map(t => (t.industry || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const filtered = [...tasks]
    .filter(t => filter === "all" ? true : (filter === "open" ? t.status !== "completed" : t.status === "completed"))
    .filter(t => tickerFilter.trim() ? (t.ticker || "").toLowerCase().includes(tickerFilter.trim().toLowerCase()) : true)
    .filter(t => kindFilter ? (t.kind || "").toLowerCase() === kindFilter.toLowerCase() : true)
    .filter(t => industryFilter ? (t.industry || "").trim().toLowerCase() === industryFilter.toLowerCase() : true)
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "completed" ? 1 : -1;
      const ad = a.dueDate || "9999-12-31";
      const bd = b.dueDate || "9999-12-31";
      if (ad !== bd) return ad.localeCompare(bd);
      return (b.createdAt || "").localeCompare(a.createdAt || "");
    });

  const startEdit = (t) => {
    setEditingId(t.id);
    setForm({ ...t, subtasks: t.subtasks || [] });
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cancelEdit = () => { setEditingId(null); setForm(emptyTask()); };

  const handleSave = () => {
    if (!form.text.trim()) { alert("Task text is required."); return; }
    onSaveTask({ ...form, ticker: finalizeTicker(form.ticker), text: form.text.trim(), kind: form.kind.trim(), industry: form.industry.trim(), notes: form.notes.trim() });
    setEditingId(null);
    setForm(emptyTask());
  };

  // Subtask helpers — mutate a copy of the task and call onSaveTask
  const addSubtask = (task, text) => {
    if (!text.trim()) return;
    const updated = { ...task, subtasks: [...(task.subtasks || []), emptySubtask(text.trim())] };
    onSaveTask(updated);
    setSubtaskInputs(prev => ({ ...prev, [task.id]: "" }));
  };

  const toggleSubtask = (task, subId) => {
    const subtasks = (task.subtasks || []).map(s => {
      if (s.id !== subId) return s;
      const done = s.status !== "completed";
      return { ...s, status: done ? "completed" : "open", completedAt: done ? new Date().toISOString() : null };
    });
    onSaveTask({ ...task, subtasks });
  };

  const deleteSubtask = (task, subId) => {
    onSaveTask({ ...task, subtasks: (task.subtasks || []).filter(s => s.id !== subId) });
  };

  const today = new Date().toISOString().split("T")[0];

  return (<>
    <div className="page-title">Tasks</div>
    <div className="page-sub">Required: ticker. Optional: kind, due date, notes, subtasks.</div>

    <div ref={formRef} className="card" style={{marginBottom:16,border: editingId ? `2px solid ${P}` : "1px solid #E2E8F0"}}>
      {editingId && <div style={{fontSize:12,fontWeight:600,color:P,marginBottom:10}}>✎ Editing task — make changes below then click Update</div>}
      <div className="todo-form-grid tasks">
        <input className="inp" placeholder="Ticker (or -)" value={form.ticker}
          onChange={e => setForm(prev => ({ ...prev, ticker: normalizeTickerInput(e.target.value, prev.ticker) }))}
          onBlur={() => setForm(prev => ({ ...prev, ticker: prev.ticker.trim() || "-" }))} />
        <input className="inp" placeholder="Task text" value={form.text} onChange={e => setForm(prev => ({ ...prev, text: e.target.value }))} />
        <input className="inp" placeholder="Kind (concall/model/note)" value={form.kind} onChange={e => setForm(prev => ({ ...prev, kind: e.target.value }))} />
        <input className="inp" placeholder="Industry (optional)" value={form.industry} onChange={e => setForm(prev => ({ ...prev, industry: e.target.value }))} />
        <input className="inp" type="date" value={form.dueDate} onChange={e => setForm(prev => ({ ...prev, dueDate: e.target.value }))} />
      </div>
      <textarea className="inp" rows={2} placeholder="Optional notes" value={form.notes} onChange={e => setForm(prev => ({ ...prev, notes: e.target.value }))} style={{resize:"vertical",marginBottom:10}} />
      <div style={{display:"flex",gap:8}}>
        <button className="btn btn-p" onClick={handleSave}>{editingId ? "Update Task" : "Add Task"}</button>
        {editingId && <button className="btn btn-o" onClick={cancelEdit}>Cancel</button>}
      </div>
    </div>

    <div className="todo-actions" style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
      {["open", "completed", "all"].map(f => <button key={f} className={`btn ${filter===f?"btn-p":"btn-o"}`} style={{textTransform:"capitalize"}} onClick={() => setFilter(f)}>{f}</button>)}
      <input className="inp" style={{maxWidth:180}} placeholder="Filter ticker" value={tickerFilter} onChange={e => setTickerFilter(e.target.value)} />
      <select className="inp" style={{maxWidth:180}} value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
        <option value="">All kinds</option>
        {kinds.map(k => <option key={k} value={k}>{k}</option>)}
      </select>
      <select className="inp" style={{maxWidth:180}} value={industryFilter} onChange={e => setIndustryFilter(e.target.value)}>
        <option value="">All industries</option>
        {industries.map(industry => <option key={industry} value={industry}>{industry}</option>)}
      </select>
    </div>

    <div className="tbl-wrap"><table className="tbl"><thead><tr><th></th><th>Ticker</th><th>Task</th><th>Kind</th><th>Due</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{filtered.length === 0 ? <tr><td colSpan={7} style={{textAlign:"center",padding:36,color:"#94A3B8"}}>No tasks found</td></tr> :
        filtered.flatMap(t => {
          const overdue = t.status !== "completed" && t.dueDate && t.dueDate < today;
          const subs = t.subtasks || [];
          const doneSubs = subs.filter(s => s.status === "completed").length;
          const isExpanded = expandedId === t.id;
          const rows = [];

          rows.push(
            <tr key={t.id} style={{background: isExpanded ? "#FAFBFC" : ""}}>
              <td style={{width:28,textAlign:"center",padding:"12px 4px"}}>
                <button onClick={() => setExpandedId(isExpanded ? null : t.id)}
                  style={{background:"none",border:"none",cursor:"pointer",fontSize:13,color:P,padding:2,lineHeight:1,fontWeight:700}}
                  title={isExpanded ? "Hide subtasks" : "Show / add subtasks"}>
                  {isExpanded ? "▾" : "▸"}
                </button>
              </td>
              <td style={{fontWeight:700}}>{t.ticker || "-"}</td>
              <td>
                <div style={{fontWeight:600,fontSize:13}}>
                  {t.text}
                  {subs.length > 0 && <span className="subtask-progress">{doneSubs}/{subs.length}</span>}
                </div>
                {t.notes ? <div style={{fontSize:12,color:"#64748B",marginTop:2}}>{t.notes}</div> : null}
                              {t.industry ? <div style={{fontSize:11,color:P,fontWeight:600,marginTop:2}}>{t.industry}</div> : null}
              </td>
              <td>{t.kind || "-"}</td>
              <td style={{color:overdue ? "#DC2626" : "inherit",fontWeight:overdue ? 700 : 500}}>{t.dueDate ? fmtDate(t.dueDate) : "-"}</td>
              <td><span className={`badge ${t.status === "completed" ? "badge-paid" : "badge-finalized"}`}>{t.status}</span></td>
              <td style={{whiteSpace:"nowrap"}}>
                <button className="btn btn-s" style={{marginRight:6}} onClick={() => startEdit(t)}>Edit</button>
                <button className="btn btn-s" style={{marginRight:6}} onClick={() => onToggleTask(t.id)}>{t.status === "completed" ? "Reopen" : "Done"}</button>
                <button className="btn btn-d" onClick={() => { if (confirm("Delete this task?")) onDeleteTask(t.id); }}>✕</button>
              </td>
            </tr>
          );

          if (isExpanded) {
            rows.push(
              <tr key={`${t.id}-subs`}>
                <td colSpan={7} style={{padding:0}}>
                  <div className="subtask-panel">
                    <div style={{fontSize:11,fontWeight:700,color:"#64748B",textTransform:"uppercase",letterSpacing:".4px",marginBottom:6}}>Subtasks</div>
                    {subs.length === 0 && <div style={{fontSize:13,color:"#94A3B8",marginBottom:8}}>No subtasks yet — add one below.</div>}
                    {subs.map(s => (
                      <div key={s.id} className="subtask-item">
                        <input type="checkbox" className="subtask-check" checked={s.status === "completed"} onChange={() => toggleSubtask(t, s.id)} />
                        <span className={`subtask-text ${s.status === "completed" ? "done" : ""}`}>{s.text}</span>
                        <button onClick={() => deleteSubtask(t, s.id)}
                          style={{background:"none",border:"none",cursor:"pointer",color:"#CBD5E1",fontSize:14,padding:"0 4px",lineHeight:1,flexShrink:0}}
                          title="Remove subtask">✕</button>
                      </div>
                    ))}
                    <div className="subtask-add">
                      <input className="inp" placeholder="Add subtask…" value={subtaskInputs[t.id] || ""}
                        onChange={e => setSubtaskInputs(prev => ({ ...prev, [t.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === "Enter") addSubtask(t, subtaskInputs[t.id] || ""); }}
                        style={{fontSize:13}} />
                      <button className="btn btn-s" onClick={() => addSubtask(t, subtaskInputs[t.id] || "")}>Add</button>
                    </div>
                  </div>
                </td>
              </tr>
            );
          }

          return rows;
        })}
      </tbody>
    </table></div>
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   TODO QUESTIONS
   ═══════════════════════════════════════════════════════════════ */
function TodoQuestions({ questions, onSaveQuestion, onSetQuestionStatus, onDeleteQuestion }) {
  const [form, setForm] = useState(emptyQuestion());
  const [editingId, setEditingId] = useState(null);
  const [statusFilter, setStatusFilter] = useState("open");
  const [search, setSearch] = useState("");
  const [industryFilter, setIndustryFilter] = useState("");
  const formRef = useRef(null);
  const industries = Array.from(new Set(questions.map(q => (q.industry || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));

  const filtered = [...questions]
    .filter(q => statusFilter === "all" ? true : q.status === statusFilter)
    .filter(q => industryFilter ? (q.industry || "").trim().toLowerCase() === industryFilter.toLowerCase() : true)
    .filter(q => {
      if (!search.trim()) return true;
      const s = search.toLowerCase();
      return (q.ticker || "").toLowerCase().includes(s)
        || (q.text || "").toLowerCase().includes(s)
        || (q.kind || "").toLowerCase().includes(s);
    })
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));

  const startEdit = (q) => {
    setEditingId(q.id);
    setForm({ ...q });
    formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const cancelEdit = () => { setEditingId(null); setForm(emptyQuestion()); };

  const handleSave = () => {
    if (!form.text.trim()) { alert("Question text is required."); return; }
    onSaveQuestion({ ...form, ticker: finalizeTicker(form.ticker), text: form.text.trim(), kind: form.kind.trim(), industry: form.industry.trim() });
    setEditingId(null);
    setForm(emptyQuestion());
  };

  return (<>
    <div className="page-title">Questions</div>
    <div className="page-sub">Capture unknowns quickly. Status can be open, resolved, or stale.</div>

    <div ref={formRef} className="card" style={{marginBottom:16,border: editingId ? `2px solid ${P}` : "1px solid #E2E8F0"}}>
      {editingId && <div style={{fontSize:12,fontWeight:600,color:P,marginBottom:10}}>✎ Editing question — make changes below then click Update</div>}
      <div className="todo-form-grid questions">
        <input className="inp" placeholder="Ticker (or -)" value={form.ticker}
          onChange={e => setForm(prev => ({ ...prev, ticker: normalizeTickerInput(e.target.value, prev.ticker) }))}
          onBlur={() => setForm(prev => ({ ...prev, ticker: prev.ticker.trim() || "-" }))} />
        <input className="inp" placeholder="Question text" value={form.text} onChange={e => setForm(prev => ({ ...prev, text: e.target.value }))} />
        <input className="inp" placeholder="Kind (optional)" value={form.kind} onChange={e => setForm(prev => ({ ...prev, kind: e.target.value }))} />
        <input className="inp" placeholder="Industry (optional)" value={form.industry} onChange={e => setForm(prev => ({ ...prev, industry: e.target.value }))} />
        <input className="inp" type="date" value={form.dueDate} onChange={e => setForm(prev => ({ ...prev, dueDate: e.target.value }))} />
        <select className="inp" value={form.status} onChange={e => setForm(prev => ({ ...prev, status: e.target.value }))}>
          <option value="open">open</option>
          <option value="resolved">resolved</option>
          <option value="stale">stale</option>
        </select>
      </div>
      <div style={{display:"flex",gap:8}}>
        <button className="btn btn-p" onClick={handleSave}>{editingId ? "Update Question" : "Add Question"}</button>
        {editingId && <button className="btn btn-o" onClick={cancelEdit}>Cancel</button>}
      </div>
    </div>

    <div className="todo-actions" style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap",alignItems:"center"}}>
      {["open", "resolved", "stale", "all"].map(f => <button key={f} className={`btn ${statusFilter===f?"btn-p":"btn-o"}`} style={{textTransform:"capitalize"}} onClick={() => setStatusFilter(f)}>{f}</button>)}
      <input className="inp" style={{maxWidth:240}} placeholder="Search questions" value={search} onChange={e => setSearch(e.target.value)} />
      <select className="inp" style={{maxWidth:180}} value={industryFilter} onChange={e => setIndustryFilter(e.target.value)}>
        <option value="">All industries</option>
        {industries.map(industry => <option key={industry} value={industry}>{industry}</option>)}
      </select>
    </div>

    <div className="tbl-wrap"><table className="tbl"><thead><tr><th>Ticker</th><th>Question</th><th>Kind</th><th>Due</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{filtered.length === 0 ? <tr><td colSpan={6} style={{textAlign:"center",padding:36,color:"#94A3B8"}}>No questions found</td></tr> :
        filtered.map(q => <tr key={q.id}>
          <td style={{fontWeight:700}}>{q.ticker || "-"}</td>
          <td>
            <div style={{fontWeight:600}}>{q.text}</div>
            {q.industry ? <div style={{fontSize:11,color:P,fontWeight:600,marginTop:2}}>{q.industry}</div> : null}
          </td>
          <td>{q.kind || "-"}</td>
          <td>{q.dueDate ? fmtDate(q.dueDate) : "-"}</td>
          <td><span className={`badge ${q.status === "resolved" ? "badge-paid" : q.status === "stale" ? "badge-draft" : "badge-finalized"}`}>{q.status}</span></td>
          <td style={{whiteSpace:"nowrap"}}>
            <button className="btn btn-s" style={{marginRight:6}} onClick={() => startEdit(q)}>Edit</button>
            <select className="inp" style={{display:"inline-block",width:110,marginRight:6,padding:"6px 8px"}} value={q.status} onChange={e => onSetQuestionStatus(q.id, e.target.value)}>
              <option value="open">open</option>
              <option value="resolved">resolved</option>
              <option value="stale">stale</option>
            </select>
            <button className="btn btn-d" onClick={() => { if (confirm("Delete this question?")) onDeleteQuestion(q.id); }}>✕</button>
          </td>
        </tr>)}
      </tbody>
    </table></div>
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   TRACKER
   ═══════════════════════════════════════════════════════════════ */
function Tracker({ tracker, onSave }) {
  const today = new Date().toISOString().split("T")[0];
  const logs = tracker.routines.logs;
  const seasons = tracker.seasons;

  /* ── helpers ── */
  const isLoggedToday = (routineId) => (logs[today] || []).includes(routineId);

  const toggleRoutine = (routineId) => {
    const todayLogs = logs[today] ? [...logs[today]] : [];
    const next = todayLogs.includes(routineId)
      ? todayLogs.filter(r => r !== routineId)
      : [...todayLogs, routineId];
    const newLogs = { ...logs, [today]: next };
    onSave({ routines: { logs: newLogs }, seasons });
  };

  /* ── heatmap: last 16 weeks = 112 days ── */
  const heatmapDays = (() => {
    const days = [];
    for (let i = 111; i >= 0; i--) {
      const d = new Date(today + "T00:00:00");
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().split("T")[0]);
    }
    return days;
  })();

  const heatmapIntensity = (date) => {
    const done = (logs[date] || []).length;
    const total = ROUTINES.length;
    if (done === 0) return 0;
    if (done / total <= 0.33) return 1;
    if (done / total <= 0.66) return 2;
    return 3;
  };

  const heatColors = ["#E2E8F0", "#C4B5FD", "#8B5CF6", P];

  /* ── season helpers ── */
  const [newSeasonName, setNewSeasonName] = useState("");
  const [expandedSeason, setExpandedSeason] = useState(null);
  const [tickerInputs, setTickerInputs] = useState({});

  const addSeason = () => {
    if (!newSeasonName.trim()) return;
    const updated = [...seasons, { id: uid(), name: newSeasonName.trim(), active: true, companies: [] }];
    setNewSeasonName("");
    onSave({ routines: { logs }, seasons: updated });
  };

  const deleteSeason = (id) => {
    onSave({ routines: { logs }, seasons: seasons.filter(s => s.id !== id) });
  };

  const toggleSeasonActive = (id) => {
    const updated = seasons.map(s => s.id === id ? { ...s, active: !s.active } : s);
    onSave({ routines: { logs }, seasons: updated });
  };

  const addCompany = (seasonId) => {
    const ticker = (tickerInputs[seasonId] || "").trim().toUpperCase();
    if (!ticker) return;
    const updated = seasons.map(s => {
      if (s.id !== seasonId) return s;
      return { ...s, companies: [...s.companies, { id: uid(), ticker, resultsRead: false, concallRead: false, deckRead: false, date: today, note: "" }] };
    });
    setTickerInputs(prev => ({ ...prev, [seasonId]: "" }));
    onSave({ routines: { logs }, seasons: updated });
  };

  const updateCompany = (seasonId, compId, patch) => {
    const updated = seasons.map(s => {
      if (s.id !== seasonId) return s;
      return { ...s, companies: s.companies.map(c => c.id === compId ? { ...c, ...patch } : c) };
    });
    onSave({ routines: { logs }, seasons: updated });
  };

  const deleteCompany = (seasonId, compId) => {
    const updated = seasons.map(s => {
      if (s.id !== seasonId) return s;
      return { ...s, companies: s.companies.filter(c => c.id !== compId) };
    });
    onSave({ routines: { logs }, seasons: updated });
  };

  /* ── streak ── */
  const dailyRoutines = ROUTINES.filter(r => r.freq === "daily");
  const calcStreak = () => {
    let streak = 0;
    const d = new Date(today + "T00:00:00");
    while (true) {
      const key = d.toISOString().split("T")[0];
      const done = (logs[key] || []).filter(id => dailyRoutines.some(r => r.id === id)).length;
      if (done === 0) break;
      streak++;
      d.setDate(d.getDate() - 1);
    }
    return streak;
  };
  const streak = calcStreak();

  return (<>
    <div className="page-title">Tracker</div>
    <div className="page-sub">Daily routines, consistency heatmap, and seasonal research logs.</div>

    {/* ── Stats row ── */}
    <div className="cards" style={{gridTemplateColumns:"repeat(3,1fr)",marginBottom:24}}>
      <div className="card"><div className="card-label">Today's Routines</div><div className="card-val" style={{color:P}}>{(logs[today]||[]).length} / {ROUTINES.length}</div></div>
      <div className="card"><div className="card-label">Daily Streak</div><div className="card-val" style={{color:streak>0?"#10B981":"#94A3B8"}}>{streak} day{streak!==1?"s":""}</div></div>
      <div className="card"><div className="card-label">Active Seasons</div><div className="card-val" style={{color:"#8B5CF6"}}>{seasons.filter(s=>s.active).length}</div></div>
    </div>

    {/* ── Routines check-in ── */}
    <div className="card" style={{marginBottom:24}}>
      <div style={{fontWeight:700,fontSize:15,marginBottom:14}}>Today's Routines — {fmtDate(today)}</div>
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {ROUTINES.map(r => {
          const done = isLoggedToday(r.id);
          return (
            <div key={r.id} onClick={() => toggleRoutine(r.id)} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderRadius:8,border:`1.5px solid ${done?"#10B981":"#E2E8F0"}`,background:done?"#F0FDF4":"#fff",cursor:"pointer",transition:"all .15s",userSelect:"none"}}>
              <div style={{width:22,height:22,borderRadius:6,background:done?"#10B981":"#E2E8F0",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,transition:"background .15s"}}>
                {done && <span style={{color:"#fff",fontSize:13,fontWeight:700}}>✓</span>}
              </div>
              <div style={{flex:1}}>
                <div style={{fontWeight:600,fontSize:13,color:done?"#065F46":"#1a1a2e"}}>{r.label}</div>
              </div>
              <span style={{fontSize:11,color:"#94A3B8",textTransform:"uppercase",letterSpacing:".4px"}}>{r.freq}</span>
            </div>
          );
        })}
      </div>
    </div>

    {/* ── Heatmap ── */}
    <div className="card" style={{marginBottom:24,overflowX:"auto"}}>
      <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>Consistency — Last 16 Weeks</div>
      <div style={{display:"flex",gap:3,flexWrap:"nowrap",minWidth:"fit-content"}}>
        {(() => {
          // Group into weeks (columns of 7)
          const weeks = [];
          for (let i = 0; i < heatmapDays.length; i += 7) {
            weeks.push(heatmapDays.slice(i, i + 7));
          }
          return weeks.map((week, wi) => (
            <div key={wi} style={{display:"flex",flexDirection:"column",gap:3}}>
              {week.map(d => {
                const intensity = heatmapIntensity(d);
                const count = (logs[d] || []).length;
                return (
                  <div key={d} title={`${d}: ${count}/${ROUTINES.length} routines`}
                    style={{width:14,height:14,borderRadius:3,background:heatColors[intensity],cursor:"default",transition:"background .15s"}} />
                );
              })}
            </div>
          ));
        })()}
      </div>
      <div style={{display:"flex",gap:6,alignItems:"center",marginTop:10,fontSize:11,color:"#94A3B8"}}>
        <span>Less</span>
        {heatColors.map((c, i) => <div key={i} style={{width:12,height:12,borderRadius:2,background:c}} />)}
        <span>More</span>
      </div>
    </div>

    {/* ── Research Seasons ── */}
    <div style={{fontWeight:700,fontSize:15,marginBottom:12}}>Research Seasons</div>

    {/* Add season */}
    <div style={{display:"flex",gap:8,marginBottom:16}}>
      <input className="inp" style={{maxWidth:320}} placeholder="New season name (e.g. Q4 FY26 Results)" value={newSeasonName} onChange={e => setNewSeasonName(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") addSeason(); }} />
      <button className="btn btn-p" onClick={addSeason}>+ Add Season</button>
    </div>

    {seasons.length === 0 && <div style={{color:"#94A3B8",fontSize:13,marginBottom:24}}>No seasons yet. Add one above.</div>}

    {seasons.map(season => {
      const isOpen = expandedSeason === season.id;
      const done = season.companies.filter(c => c.resultsRead && c.concallRead && c.deckRead).length;
      return (
        <div key={season.id} className="card" style={{marginBottom:14,padding:0,border:`1.5px solid ${season.active?P:"#E2E8F0"}`}}>
          {/* Season header */}
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"12px 16px",cursor:"pointer"}} onClick={() => setExpandedSeason(isOpen ? null : season.id)}>
            <span style={{fontSize:14,color:P,fontWeight:700}}>{isOpen?"▾":"▸"}</span>
            <div style={{flex:1}}>
              <span style={{fontWeight:700,fontSize:14}}>{season.name}</span>
              <span style={{fontSize:12,color:"#94A3B8",marginLeft:10}}>{season.companies.length} companies · {done} fully done</span>
            </div>
            <span style={{fontSize:11,fontWeight:600,padding:"3px 10px",borderRadius:99,background:season.active?"#EDE9FE":"#F1F5F9",color:season.active?P:"#94A3B8"}}>{season.active?"Active":"Archived"}</span>
            <button className="btn btn-o" style={{fontSize:11,padding:"4px 8px"}} onClick={e => { e.stopPropagation(); toggleSeasonActive(season.id); }}>{season.active?"Archive":"Activate"}</button>
            <button className="btn btn-d" style={{fontSize:11,padding:"4px 8px"}} onClick={e => { e.stopPropagation(); if(confirm("Delete this season?")) deleteSeason(season.id); }}>✕</button>
          </div>

          {isOpen && (
            <div style={{borderTop:"1px solid #E2E8F0",padding:"14px 16px"}}>
              {/* Add company */}
              <div style={{display:"flex",gap:8,marginBottom:14}}>
                <input className="inp" style={{maxWidth:180}} placeholder="Add ticker (e.g. BAJAJCON)"
                  value={tickerInputs[season.id] || ""}
                  onChange={e => setTickerInputs(prev => ({...prev,[season.id]:e.target.value}))}
                  onKeyDown={e => { if (e.key === "Enter") addCompany(season.id); }} />
                <button className="btn btn-s" onClick={() => addCompany(season.id)}>+ Add Company</button>
              </div>

              {season.companies.length === 0 && <div style={{color:"#94A3B8",fontSize:13,marginBottom:8}}>No companies yet — add a ticker above.</div>}

              {/* Company table */}
              {season.companies.length > 0 && (
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>Ticker</th>
                        <th style={{textAlign:"center"}}>Results</th>
                        <th style={{textAlign:"center"}}>Concall</th>
                        <th style={{textAlign:"center"}}>Deck</th>
                        <th>Date</th>
                        <th>Note</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {season.companies.map(c => {
                        const allDone = c.resultsRead && c.concallRead && c.deckRead;
                        return (
                          <tr key={c.id} style={{background: allDone ? "#F0FDF4" : ""}}>
                            <td style={{fontWeight:700,color:allDone?"#065F46":P}}>{c.ticker}</td>
                            <td style={{textAlign:"center"}}>
                              <input type="checkbox" style={{width:16,height:16,accentColor:P,cursor:"pointer"}}
                                checked={c.resultsRead} onChange={e => updateCompany(season.id, c.id, {resultsRead: e.target.checked})} />
                            </td>
                            <td style={{textAlign:"center"}}>
                              <input type="checkbox" style={{width:16,height:16,accentColor:P,cursor:"pointer"}}
                                checked={c.concallRead} onChange={e => updateCompany(season.id, c.id, {concallRead: e.target.checked})} />
                            </td>
                            <td style={{textAlign:"center"}}>
                              <input type="checkbox" style={{width:16,height:16,accentColor:P,cursor:"pointer"}}
                                checked={c.deckRead} onChange={e => updateCompany(season.id, c.id, {deckRead: e.target.checked})} />
                            </td>
                            <td>
                              <input type="date" className="inp" style={{fontSize:12,padding:"4px 8px",minWidth:130}}
                                value={c.date} onChange={e => updateCompany(season.id, c.id, {date: e.target.value})} />
                            </td>
                            <td>
                              <input className="inp" style={{fontSize:12,padding:"4px 8px",minWidth:140}} placeholder="Quick note…"
                                value={c.note} onChange={e => updateCompany(season.id, c.id, {note: e.target.value})} />
                            </td>
                            <td>
                              <button className="btn btn-d" style={{padding:"4px 8px",fontSize:11}} onClick={() => deleteCompany(season.id, c.id)}>✕</button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      );
    })}
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   ITEM AUTOCOMPLETE
   ═══════════════════════════════════════════════════════════════ */
function ItemAutocomplete({ value, suggestions, onChange, onSelect }) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(-1);
  const ref = useRef(null);

  const filtered = value.trim()
    ? suggestions.filter(s => s.description.toLowerCase().includes(value.toLowerCase()))
    : suggestions;

  useEffect(() => {
    const handleClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const handleKey = (e) => {
    if (!open || filtered.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlighted(h => Math.min(h + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlighted(h => Math.max(h - 1, 0)); }
    else if (e.key === "Enter" && highlighted >= 0) { e.preventDefault(); onSelect(filtered[highlighted]); setOpen(false); setHighlighted(-1); }
    else if (e.key === "Escape") { setOpen(false); }
  };

  return (
    <div ref={ref} style={{position:"relative"}}>
      <input className="inp" placeholder="e.g. AWS - Servers" value={value}
        onChange={e => { onChange(e.target.value); setOpen(true); setHighlighted(-1); }}
        onFocus={() => { if (suggestions.length > 0) setOpen(true); }}
        onKeyDown={handleKey} />
      {open && filtered.length > 0 && (
        <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:50,background:"#fff",border:"1px solid #E2E8F0",borderRadius:8,boxShadow:"0 8px 24px rgba(0,0,0,0.12)",maxHeight:200,overflowY:"auto",marginTop:2}}>
          {filtered.map((s, i) => (
            <div key={s.description} onMouseDown={() => { onSelect(s); setOpen(false); }}
              onMouseEnter={() => setHighlighted(i)}
              style={{padding:"8px 12px",fontSize:13,cursor:"pointer",display:"flex",justifyContent:"space-between",alignItems:"center",
                background: i === highlighted ? PL : "#fff",
                borderBottom: i < filtered.length - 1 ? "1px solid #F1F5F9" : "none"}}>
              <span style={{fontWeight:500}}>{s.description}</span>
              <span style={{fontSize:11,color:"#94A3B8",whiteSpace:"nowrap",marginLeft:12}}>₹{fmt(s.rate)} · {s.gst}%</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════
   INVOICE FORM
   ═══════════════════════════════════════════════════════════════ */
function InvForm({ inv: initial, onSave, onCancel, allInvoices }) {
  const [inv, setInv] = useState(initial);
  const [recOn, setRecOn] = useState(!!initial.recurring?.active);
  const [recFreq, setRecFreq] = useState(initial.recurring?.frequency || "monthly");

  // Build unique past items (deduplicated by description, latest wins)
  const pastItems = (() => {
    const map = new Map();
    allInvoices.forEach(inv => inv.items?.forEach(it => {
      if (it.description?.trim()) map.set(it.description.trim().toLowerCase(), { description: it.description.trim(), hsn: it.hsn || "", gst: it.gst ?? 18, rate: it.rate || "" });
    }));
    return Array.from(map.values());
  })();

  const update = (f, v) => setInv(prev => { const n = { ...prev, [f]: v }; if (f === "invoiceDate") n.dueDate = addDays(v, 15); return n; });
  const updateItem = (id, f, v) => setInv(prev => ({ ...prev, items: prev.items.map(it => it.id===id ? {...it, [f]:v} : it) }));
  const autofillItem = (id, past) => setInv(prev => ({ ...prev, items: prev.items.map(it => it.id===id ? {...it, description: past.description, hsn: past.hsn, gst: past.gst, rate: past.rate } : it) }));
  const addItem = () => setInv(prev => ({ ...prev, items: [...prev.items, emptyItem()] }));
  const removeItem = (id) => setInv(prev => ({ ...prev, items: prev.items.length > 1 ? prev.items.filter(i => i.id!==id) : prev.items }));

  const ci = computeItems(inv.items), totals = computeTotals(ci);
  const isEdit = allInvoices.find(i => i.id === inv.id);

  const handleSave = (status) => {
    onSave({ ...inv, status, recurring: recOn ? { active: true, frequency: recFreq, nextDate: nextDate(inv.invoiceDate, recFreq), lastGenerated: null } : null });
  };

  return (<>
    <div className="form-header" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:24}}>
      <div className="page-title">{isEdit ? "Edit Invoice" : "New Invoice"}</div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button className="btn btn-o" onClick={onCancel}>Cancel</button>
        <button className="btn btn-s" onClick={() => handleSave("draft")}>Save Draft</button>
        <button className="btn btn-p" onClick={() => handleSave("finalized")}>Finalize</button>
      </div>
    </div>

    <div className="form-meta" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16,marginBottom:24,background:"#fff",padding:20,borderRadius:10,border:"1px solid #E2E8F0"}}>
      <div><label className="label">Invoice Number</label><input className="inp" value={inv.invoiceNo} onChange={e => update("invoiceNo",e.target.value)} /></div>
      <div><label className="label">Invoice Date</label><input className="inp" type="date" value={inv.invoiceDate} onChange={e => update("invoiceDate",e.target.value)} /></div>
      <div><label className="label">Due Date (+15 days)</label><input className="inp" type="date" value={inv.dueDate} readOnly /></div>
    </div>

    <div style={{background:"#fff",borderRadius:10,border:"1px solid #E2E8F0",overflow:"auto",marginBottom:16}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:13,minWidth:650}}>
        <thead><tr style={{background:P}}>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,width:36}}>#</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"left"}}>Item Description</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,width:90}}>HSN/SAC</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,width:65}}>GST %</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,width:55}}>Qty</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,width:110}}>Rate (₹)</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,width:100,textAlign:"right"}}>Amount</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,width:40}}></th>
        </tr></thead>
        <tbody>{inv.items.map((it,i) => (
          <tr key={it.id} style={{borderBottom:"1px solid #F1F5F9"}}>
            <td style={{padding:"8px",textAlign:"center",color:"#94A3B8"}}>{i+1}</td>
            <td style={{padding:"6px 8px"}}><ItemAutocomplete value={it.description} suggestions={pastItems} onChange={v => updateItem(it.id,"description",v)} onSelect={past => autofillItem(it.id, past)} /></td>
            <td style={{padding:"6px 4px"}}><input className="inp" placeholder="—" value={it.hsn} onChange={e => updateItem(it.id,"hsn",e.target.value)} /></td>
            <td style={{padding:"6px 4px"}}><input className="inp" type="number" value={it.gst} onChange={e => updateItem(it.id,"gst",e.target.value)} style={{textAlign:"center"}} /></td>
            <td style={{padding:"6px 4px"}}><input className="inp" type="number" value={it.qty} onChange={e => updateItem(it.id,"qty",e.target.value)} style={{textAlign:"center"}} /></td>
            <td style={{padding:"6px 4px"}}><input className="inp" type="number" step="0.01" placeholder="0.00" value={it.rate} onChange={e => updateItem(it.id,"rate",e.target.value)} style={{textAlign:"right"}} /></td>
            <td style={{padding:"8px",textAlign:"right",fontWeight:600}}>₹{fmt(ci[i]?.amount)}</td>
            <td style={{padding:"6px"}}><button className="btn btn-d" onClick={() => removeItem(it.id)} style={{padding:"4px 8px"}}>✕</button></td>
          </tr>))}</tbody>
      </table>
    </div>
    <button className="btn btn-s" onClick={addItem}>+ Add Item</button>

    <div style={{background:"#fff",borderRadius:10,border:"1px solid #E2E8F0",padding:20,marginTop:16}}>
      <label className="label">Internal Notes <span style={{fontWeight:400,textTransform:"none",letterSpacing:0,color:"#94A3B8"}}>(not printed on invoice)</span></label>
      <textarea className="inp" rows={3} placeholder="Add private notes, reminders, or context..." value={inv.notes||""} onChange={e => update("notes",e.target.value)} style={{resize:"vertical"}} />
    </div>

    <div className="form-bottom" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20,marginTop:16}}>
      <div style={{background:"#fff",borderRadius:10,border:"1px solid #E2E8F0",padding:20}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:recOn?16:0}}>
          <div><div style={{fontWeight:700,fontSize:14,marginBottom:2}}>Recurring Invoice</div><div style={{fontSize:12,color:"#94A3B8"}}>Auto-generate on schedule</div></div>
          <div className={`toggle ${recOn?"on":""}`} onClick={() => setRecOn(!recOn)} />
        </div>
        {recOn && <div className="rec-box">
          <label className="label">Frequency</label>
          <select className="inp" value={recFreq} onChange={e => setRecFreq(e.target.value)} style={{marginBottom:12}}><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="yearly">Yearly</option></select>
          <div style={{fontSize:12,color:"#64748B"}}>Next invoice auto-generated on <strong>{fmtDate(nextDate(inv.invoiceDate, recFreq))}</strong></div>
        </div>}
      </div>
      <div style={{background:"#fff",borderRadius:10,border:"1px solid #E2E8F0",padding:20}}>
        <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",fontSize:13,borderBottom:"1px solid #F1F5F9"}}><span>Subtotal</span><span style={{fontWeight:600}}>₹{fmt(totals.amount)}</span></div>
        <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",fontSize:13,borderBottom:"1px solid #F1F5F9",color:"#64748B"}}><span>CGST</span><span>₹{fmt(totals.cgst)}</span></div>
        <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",fontSize:13,borderBottom:"1px solid #F1F5F9",color:"#64748B"}}><span>SGST</span><span>₹{fmt(totals.sgst)}</span></div>
        <div style={{display:"flex",justifyContent:"space-between",padding:"12px 0 0",fontSize:18,fontWeight:700,color:P,borderTop:`2px solid ${P}`,marginTop:4}}><span>Total</span><span>₹{fmt(totals.total)}</span></div>
      </div>
    </div>
  </>);
}

/* ═══════════════════════════════════════════════════════════════
   PREVIEW
   ═══════════════════════════════════════════════════════════════ */
function Preview({ inv, onBack, onEdit, onDelete }) {
  const ci = computeItems(inv.items), totals = computeTotals(ci), hasHSN = ci.some(i => i.hsn);
  return (<>
    <div className="preview-actions" style={{display:"flex",gap:8,marginBottom:20,flexWrap:"wrap"}}>
      <button className="btn btn-o" onClick={onBack}>← Back</button>
      <button className="btn btn-s" onClick={onEdit}>Edit</button>
      <button className="btn btn-p" onClick={() => downloadPDF(inv)}>⌘P Download PDF</button>
      <button className="btn btn-d" onClick={() => { if(confirm("Delete?")) onDelete(); }}>Delete</button>
    </div>

    <div className="preview-box" style={{background:"#fff",borderRadius:12,border:"1px solid #E2E8F0",padding:"36px 40px",maxWidth:800}}>
      <h1 style={{fontSize:28,fontWeight:700,color:P,marginBottom:12}}>Invoice</h1>
      <div style={{fontSize:13,color:"#555",marginBottom:20,lineHeight:1.8}}>
        <div><strong style={{display:"inline-block",width:100}}>Invoice No</strong>{inv.invoiceNo}</div>
        <div><strong style={{display:"inline-block",width:100}}>Invoice Date</strong>{fmtDate(inv.invoiceDate)}</div>
        <div><strong style={{display:"inline-block",width:100}}>Due Date</strong>{fmtDate(inv.dueDate)}</div>
      </div>

      <div className="preview-parties" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
        {[["Billed By",BILLED_BY],["Billed To",BILLED_TO]].map(([l,e]) => <div key={l} style={{background:PL,borderRadius:6,padding:16}}>
          <div style={{color:P,fontWeight:700,fontSize:13,marginBottom:8}}>{l}</div>
          <div style={{fontWeight:700,marginBottom:4}}>{e.name}</div>
          <div style={{fontSize:12,color:"#555",lineHeight:1.6}}>{e.line1}<br/>{e.line2}<br/>{e.line3}</div>
          <div style={{fontSize:12,color:"#555",marginTop:4}}><strong>GSTIN:</strong> {e.gstin}</div>
          <div style={{fontSize:12,color:"#555"}}><strong>PAN:</strong> {e.pan}</div>
        </div>)}
      </div>

      <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:"#666",padding:"8px 0",borderBottom:"1px solid #e2e2e2",marginBottom:16}}><span>Country of Supply: India</span><span>Place of Supply: Gujarat (24)</span></div>

      <div style={{overflowX:"auto",marginBottom:20}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12,minWidth:580}}>
        <thead><tr style={{background:P}}>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"center",width:32}}></th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"left"}}>Item</th>
          {hasHSN && <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"center"}}>HSN/SAC</th>}
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"center",lineHeight:1.3}}>GST<br/>Rate</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"center"}}>Quantity</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"right"}}>Rate</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"right"}}>Amount</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"right"}}>CGST</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"right"}}>SGST</th>
          <th style={{padding:"10px 8px",color:"#fff",fontSize:11,fontWeight:600,textAlign:"right"}}>Total</th>
        </tr></thead>
        <tbody>{ci.map((it,i) => <tr key={it.id} style={{borderBottom:"1px solid #eee"}}>
          <td style={{padding:"10px 8px",textAlign:"center"}}>{i+1}.</td>
          <td style={{padding:"10px 8px",textAlign:"left",fontWeight:500}}>{it.description}</td>
          {hasHSN && <td style={{padding:"10px 8px",textAlign:"center"}}>{it.hsn||"—"}</td>}
          <td style={{padding:"10px 8px",textAlign:"center"}}>{it.gst}%</td>
          <td style={{padding:"10px 8px",textAlign:"center"}}>{it.qty}</td>
          <td style={{padding:"10px 8px",textAlign:"right"}}>₹{fmt(it.rate||0)}</td>
          <td style={{padding:"10px 8px",textAlign:"right"}}>₹{fmt(it.amount)}</td>
          <td style={{padding:"10px 8px",textAlign:"right"}}>₹{fmt(it.cgst)}</td>
          <td style={{padding:"10px 8px",textAlign:"right"}}>₹{fmt(it.sgst)}</td>
          <td style={{padding:"10px 8px",textAlign:"right",fontWeight:600}}>₹{fmt(it.total)}</td>
        </tr>)}</tbody>
      </table>
      </div>

      <div className="preview-summary" style={{display:"flex",gap:24,marginBottom:24}}>
        <div style={{flex:1,fontSize:11.5,color:"#444",lineHeight:1.6,paddingTop:4}}><strong>Total (in words) :</strong> {numberToWordsINR(totals.total)}</div>
        <div style={{width:260}}>
          <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",fontSize:13,borderBottom:"1px solid #eee"}}><span>Amount</span><span>₹{fmt(totals.amount)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",fontSize:13,borderBottom:"1px solid #eee"}}><span>CGST</span><span>₹{fmt(totals.cgst)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"6px 0",fontSize:13,borderBottom:"1px solid #eee"}}><span>SGST</span><span>₹{fmt(totals.sgst)}</span></div>
          <div style={{display:"flex",justifyContent:"space-between",padding:"10px 0 0",fontSize:16,fontWeight:700,borderTop:`2px solid ${P}`,marginTop:4}}><span>Total (INR)</span><span>₹{fmt(totals.total)}</span></div>
        </div>
      </div>

      <div className="preview-bank" style={{display:"flex",gap:24,marginBottom:24}}>
        <div style={{flex:1,background:PL,borderRadius:6,padding:16}}>
          <div style={{color:P,fontWeight:700,fontSize:12,marginBottom:10}}>Bank Details</div>
          {[["Account Name",BANK.name],["Account Number",BANK.number],["IFSC",BANK.ifsc],["Account Type",BANK.type],["Bank",BANK.bank]].map(([k,v]) => <div key={k} style={{display:"flex",fontSize:12,marginBottom:3}}><span style={{width:110,color:"#888"}}>{k}</span><span style={{fontWeight:500}}>{v}</span></div>)}
        </div>
        <div style={{width:180,display:"flex",flexDirection:"column",alignItems:"flex-end",justifyContent:"flex-end"}}>
          <div style={{textAlign:"center"}}>
            <div style={{fontFamily:"'Caveat',cursive",fontSize:32,color:"#333",marginBottom:2}}>Pranjal</div>
            <div style={{borderTop:"1px solid #ccc",paddingTop:6,fontSize:12,color:"#666"}}>Partner</div>
          </div>
        </div>
      </div>

      <div style={{borderTop:"1px solid #e2e2e2",paddingTop:16,marginBottom:24}}>
        <div style={{color:P,fontWeight:700,fontSize:13,marginBottom:8}}>Terms and Conditions</div>
        <div style={{fontSize:12,color:"#555",lineHeight:1.7}}>1. Please pay within 15 days from the date of invoice.<br/>2. Please quote invoice number when remitting funds.</div>
      </div>

      <div style={{borderTop:"2px dashed #ccc",paddingTop:12,display:"flex",justifyContent:"space-between",fontSize:11,color:"#888"}}>
        <div><strong>Invoice No</strong><br/>{inv.invoiceNo}</div>
        <div><strong>Invoice Date</strong><br/>{fmtDateShort(inv.invoiceDate)}</div>
        <div><strong>Billed To</strong><br/>{BILLED_TO.name}</div>
        <div style={{textAlign:"right"}}>Page 1 of 1</div>
      </div>
    </div>

    {inv.notes && <div style={{background:"#FFFBEB",border:"1px solid #FDE68A",borderRadius:10,padding:16,marginTop:16,maxWidth:800}}>
      <div style={{fontSize:12,fontWeight:700,color:"#92400E",marginBottom:6,display:"flex",alignItems:"center",gap:6}}>📝 Internal Notes <span style={{fontWeight:400,fontSize:11,color:"#B45309"}}>(not on printed invoice)</span></div>
      <div style={{fontSize:13,color:"#78350F",lineHeight:1.6,whiteSpace:"pre-wrap"}}>{inv.notes}</div>
    </div>}
  </>);
}
