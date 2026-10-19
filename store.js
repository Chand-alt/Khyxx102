'use strict';
/**
 * Storage layer for orders, inquiries, receipts and editable settings.
 *
 * Three modes, picked automatically:
 *   - "kv"       Upstash Redis / Vercel KV (set KV_REST_API_URL + KV_REST_API_TOKEN,
 *                or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Use this on Vercel.
 *   - "file"     data/runtime.json on your own computer or a normal server (local dev).
 *   - "readonly" Serverless host with no KV configured. Files can't be written there, so
 *                we REFUSE new orders instead of pretending to save them.
 */
const fs = require('fs');
const path = require('path');

const SEED_PATH = path.join(__dirname, 'data', 'database.json');
const RUNTIME_PATH = path.join(__dirname, 'data', 'runtime.json');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const SERVERLESS = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

const MODE = KV_URL && KV_TOKEN ? 'kv' : SERVERLESS ? 'readonly' : 'file';

class StoreUnavailable extends Error {
  constructor(msg) { super(msg || 'Storage is not configured'); this.name = 'StoreUnavailable'; }
}

function readSeed() {
  try { return JSON.parse(fs.readFileSync(SEED_PATH, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { return { settings: {} }; }
}

/* ------------------------------ file mode ------------------------------ */
let fileCache = null;
function fileLoad() {
  if (fileCache) return fileCache;
  try {
    fileCache = JSON.parse(fs.readFileSync(RUNTIME_PATH, 'utf8'));
  } catch (e) {
    fileCache = { settings: readSeed().settings || {}, orders: {}, inquiries: {}, receipts: {} };
  }
  return fileCache;
}
function fileSave() {
  fs.writeFileSync(RUNTIME_PATH, JSON.stringify(fileCache, null, 2), 'utf8');
}

/* ------------------------------- kv mode ------------------------------- */
async function kv(...command) {
  const res = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`KV error: ${data.error || res.status}`);
  return data.result;
}
function hashToObject(flat) {
  const out = {};
  for (let i = 0; i < (flat || []).length; i += 2) {
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch (e) { /* skip corrupt entry */ }
  }
  return out;
}
const K = { orders: 'khyxx:orders', inquiries: 'khyxx:inquiries', settings: 'khyxx:settings', receipt: id => `khyxx:receipt:${id}` };

/* ------------------------------ public API ------------------------------ */
function assertWritable() {
  if (MODE === 'readonly') {
    throw new StoreUnavailable('This server cannot save data. Connect a database (see README-FIXES.md).');
  }
}

async function getSettings() {
  const seed = readSeed().settings || {};
  if (MODE === 'kv') {
    const saved = await kv('GET', K.settings);
    return { ...seed, ...(saved ? JSON.parse(saved) : {}) };
  }
  if (MODE === 'file') return { ...seed, ...(fileLoad().settings || {}) };
  return seed;
}
async function putSettings(settings) {
  assertWritable();
  if (MODE === 'kv') return kv('SET', K.settings, JSON.stringify(settings));
  fileLoad().settings = settings; fileSave();
}

/** Returns true if created, false if an order with this id already exists. */
async function createOrder(order) {
  assertWritable();
  if (MODE === 'kv') return (await kv('HSETNX', K.orders, order.id, JSON.stringify(order))) === 1;
  const db = fileLoad();
  if (db.orders[order.id]) return false;
  db.orders[order.id] = order; fileSave();
  return true;
}
async function getOrder(id) {
  if (MODE === 'kv') { const v = await kv('HGET', K.orders, id); return v ? JSON.parse(v) : null; }
  if (MODE === 'file') return fileLoad().orders[id] || null;
  return null;
}
async function saveOrder(order) {
  assertWritable();
  if (MODE === 'kv') return kv('HSET', K.orders, order.id, JSON.stringify(order));
  fileLoad().orders[order.id] = order; fileSave();
}
async function listOrders() {
  let list = [];
  if (MODE === 'kv') list = Object.values(hashToObject(await kv('HGETALL', K.orders)));
  else if (MODE === 'file') list = Object.values(fileLoad().orders);
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
async function deleteOrder(id) {
  assertWritable();
  if (MODE === 'kv') { const n = await kv('HDEL', K.orders, id); await kv('DEL', K.receipt(id)); return n > 0; }
  const db = fileLoad(); const had = !!db.orders[id];
  delete db.orders[id]; delete db.receipts[id]; fileSave();
  return had;
}

async function createInquiry(inq) {
  assertWritable();
  if (MODE === 'kv') return (await kv('HSETNX', K.inquiries, inq.id, JSON.stringify(inq))) === 1;
  const db = fileLoad();
  if (db.inquiries[inq.id]) return false;
  db.inquiries[inq.id] = inq; fileSave();
  return true;
}
async function getInquiry(id) {
  if (MODE === 'kv') { const v = await kv('HGET', K.inquiries, id); return v ? JSON.parse(v) : null; }
  if (MODE === 'file') return fileLoad().inquiries[id] || null;
  return null;
}
async function saveInquiry(inq) {
  assertWritable();
  if (MODE === 'kv') return kv('HSET', K.inquiries, inq.id, JSON.stringify(inq));
  fileLoad().inquiries[inq.id] = inq; fileSave();
}
async function listInquiries() {
  let list = [];
  if (MODE === 'kv') list = Object.values(hashToObject(await kv('HGETALL', K.inquiries)));
  else if (MODE === 'file') list = Object.values(fileLoad().inquiries);
  return list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** receipt = { mime: 'image/jpeg', data: '<base64>' } */
async function putReceipt(orderId, receipt) {
  assertWritable();
  if (MODE === 'kv') return kv('SET', K.receipt(orderId), JSON.stringify(receipt));
  fileLoad().receipts[orderId] = receipt; fileSave();
}
async function getReceipt(orderId) {
  if (MODE === 'kv') { const v = await kv('GET', K.receipt(orderId)); return v ? JSON.parse(v) : null; }
  if (MODE === 'file') return fileLoad().receipts[orderId] || null;
  return null;
}

module.exports = {
  MODE, StoreUnavailable,
  getSettings, putSettings,
  createOrder, getOrder, saveOrder, listOrders, deleteOrder,
  createInquiry, getInquiry, saveInquiry, listInquiries,
  putReceipt, getReceipt
};
