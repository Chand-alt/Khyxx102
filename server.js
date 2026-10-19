'use strict';
const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

app.set('trust proxy', 1);
app.disable('x-powered-by');

/* ============================ CONFIG ============================ */

// Admin PIN comes from an environment variable (never from a file in the repo).
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const ADMIN_ENABLED = ADMIN_PIN.length >= 8;
const SESSION_SECRET =
  process.env.ADMIN_SECRET ||
  crypto.createHash('sha256').update('khyxx-session|' + ADMIN_PIN).digest('hex');
const SESSION_HOURS = 12;

const NTFY_TOPIC = process.env.NTFY_TOPIC || '';

const STATUSES = ['pending_payment', 'payment_submitted', 'paid', 'completed', 'cancelled'];
const PAYMENT_METHODS = ['gcash', 'bank_transfer'];
const MAX_RECEIPT_BYTES = 900 * 1024;
const SETTINGS_KEYS = [
  'gcashNumber', 'gcashName', 'bankName', 'bankAccount', 'bankAccountName',
  'contactEmail', 'backupEmail', 'paymentQrImage'
];
const GUIDES = [
  {
    title: 'Khyxx Digitals - Canva Editing Guide (PDF)',
    description: 'Step-by-step instructions on customizing your text, fonts, colors and photos.',
    url: 'guides/Canva_Editing_Guide.pdf'
  },
  {
    title: 'Wedding Stationery & Printing Guide',
    description: 'Recommended paper weight, bleed settings and a pre-print checklist.',
    url: 'guides/Printing_Recommendations.pdf'
  }
];

if (!ADMIN_ENABLED) {
  console.warn('[khyxx] ADMIN_PIN is missing or shorter than 8 characters: admin login is DISABLED.');
}
if (store.MODE === 'readonly') {
  console.warn('[khyxx] No database connected on a serverless host: new orders will be refused. See README-FIXES.md.');
}

/* ============================ CATALOG ============================ */
// Private catalog (data/products.json). Prices and delivery links live ONLY on the server.
function loadCatalog() {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'data', 'products.json'), 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(raw).products || [];
  } catch (e) {
    console.error('Could not read data/products.json:', e.message);
    return [];
  }
}
const CATALOG = loadCatalog();
const BY_NAME = new Map(CATALOG.map(p => [p.name.trim().toLowerCase(), p]));
const BY_ID = new Map(CATALOG.map(p => [p.id, p]));

/* ============================ HELPERS ============================ */

function clean(value, max) {
  if (typeof value !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function isHttpUrl(value, max = 500) {
  if (typeof value !== 'string' || value.length > max) return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (e) { return false; }
}
function isEmail(value) {
  return typeof value === 'string' && value.length <= 150 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Unguessable code, e.g. KHYXX-7K2M-9QXA (no 0/O/1/I/L to avoid mix-ups when typing).
const ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ORDER_ID_RE = /^KHYXX-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
function randomChunk(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += ID_ALPHABET[crypto.randomInt(ID_ALPHABET.length)];
  return s;
}
const newOrderId = () => `KHYXX-${randomChunk(4)}-${randomChunk(4)}`;
const newInquiryId = () => `INQ-${randomChunk(6)}`;

// Signed, expiring admin session token (no database needed).
function b64url(buf) { return Buffer.from(buf).toString('base64url'); }
function signToken() {
  const body = b64url(JSON.stringify({ exp: Date.now() + SESSION_HOURS * 3600 * 1000 }));
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (typeof token !== 'string') return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return false;
  try { return JSON.parse(Buffer.from(body, 'base64url').toString()).exp > Date.now(); }
  catch (e) { return false; }
}

// Simple in-memory rate limiter (best effort; on serverless each instance has its own counters).
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const now = Date.now();
    let entry = hits.get(req.ip);
    if (!entry || entry.reset < now) { entry = { count: 0, reset: now + windowMs }; hits.set(req.ip, entry); }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please wait a few minutes and try again.' });
    }
    next();
  };
}
const limitOrders = rateLimit({ windowMs: 60 * 60 * 1000, max: 15 });
const limitInquiries = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
const limitTrack = rateLimit({ windowMs: 15 * 60 * 1000, max: 80 });
const limitPayment = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
const limitLogin = rateLimit({ windowMs: 15 * 60 * 1000, max: 8 });

// Optional phone push notification via ntfy.sh (set NTFY_TOPIC). Never blocks or breaks an order.
async function notify(title, message) {
  if (!NTFY_TOPIC) return;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: 'POST',
      headers: { Title: title, Tags: 'sparkles' },
      body: message,
      signal: ctrl.signal
    });
    clearTimeout(timer);
  } catch (e) { /* ignore */ }
}

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function imageKind(buf) {
  if (buf.length > 12 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return null;
}

/* ===================== SECURITY HEADERS & PARSERS ===================== */

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '30kb' }));
app.use(express.urlencoded({ extended: false, limit: '30kb' }));

/* ===================== PAGES & STATIC FILES (WHITELIST) ===================== */
// Only the pages and asset folders listed here are public. Everything else
// (server.js, data/, package.json, .git ...) returns 404.

const PAGES = {
  '/': 'index.html', '/index.html': 'index.html', '/shop.html': 'shop.html',
  '/about.html': 'about.html', '/contact.html': 'contact.html',
  '/track-order.html': 'track-order.html', '/track': 'track-order.html',
  '/admin.html': 'admin.html', '/admin': 'admin.html',
  '/garden-suite.html': 'garden-suite.html', '/minimal-letters.html': 'minimal-letters.html',
  '/romantic-vows.html': 'romantic-vows.html', '/velvet-luxe.html': 'velvet-luxe.html'
};
const htmlCache = new Map();
function sendPage(file) {
  return (req, res, next) => {
    let html = htmlCache.get(file);
    if (!html) {
      try { html = fs.readFileSync(path.join(ROOT, file), 'utf8'); }
      catch (e) { return next(); }
      if (process.env.NODE_ENV === 'production' || process.env.VERCEL) htmlCache.set(file, html);
    }
    const host = req.get('host') || '';
    const origin = /^[a-z0-9.-]+(:\d+)?$/i.test(host) ? `${req.protocol}://${host}` : '';
    if (file === 'admin.html') res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(html.replace(/\{\{ORIGIN\}\}/g, origin));
  };
}
for (const [route, file] of Object.entries(PAGES)) app.get(route, sendPage(file));

const PUBLIC_FILES = new Set(['style.css', 'java.js']);
const PUBLIC_DIRS = ['store/', 'Our story/', 'clients feedback/', 'celebration-loop.mp4/', 'guides/'];
const PUBLIC_EXT = /\.(png|jpe?g|webp|gif|svg|ico|mp4|webm|pdf|css|js)$/i;
const serveStatic = express.static(ROOT, { dotfiles: 'deny', index: false, maxAge: '7d' });
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let p;
  try { p = decodeURIComponent(req.path).replace(/^\/+/, ''); } catch (e) { return res.sendStatus(400); }
  if (p.includes('..') || p.includes('\\') || p.split('/').some(seg => seg.startsWith('.'))) return next();
  const allowed = PUBLIC_FILES.has(p) || (PUBLIC_DIRS.some(d => p.startsWith(d)) && PUBLIC_EXT.test(p));
  return allowed ? serveStatic(req, res, next) : next();
});

/* ============================ PUBLIC API ============================ */

app.get('/api/settings', wrap(async (req, res) => {
  const { adminPin, ...publicSettings } = await store.getSettings();
  res.json(publicSettings);
}));

// Public catalog. Delivery links are never included.
app.get('/api/products', (req, res) => {
  res.json(CATALOG.map(({ deliveryUrl, ...p }) => p));
});

app.post('/api/orders', limitOrders, wrap(async (req, res) => {
  const body = req.body || {};
  const name = clean(body.customer && body.customer.name, 100);
  const email = clean(body.customer && body.customer.email, 150);
  const phone = clean(body.customer && body.customer.phone, 30);
  const rawFb = clean((body.event && body.event.facebookLink) || (body.customer && body.customer.facebookLink), 300);

  if (!name) return res.status(400).json({ error: 'Please enter your full name.' });
  if (!isEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!isHttpUrl(rawFb, 300)) return res.status(400).json({ error: 'Please enter a valid Facebook / contact link (starting with https://).' });

  if (!Array.isArray(body.items) || !body.items.length || body.items.length > 20) {
    return res.status(400).json({ error: 'Your bag is empty or has too many items.' });
  }
  const items = [];
  for (const raw of body.items) {
    const product = BY_NAME.get(clean(raw && raw.name, 120).toLowerCase()) || BY_ID.get(clean(raw && raw.id, 80));
    if (!product) return res.status(400).json({ error: `"${clean(raw && raw.name, 60)}" is no longer in our catalog. Please refresh the page.` });
    if (product.available === false) return res.status(400).json({ error: `${product.name} is not available yet.` });
    const quantity = Math.floor(Number(raw.quantity) || 1);
    if (quantity < 1 || quantity > 10) return res.status(400).json({ error: 'Invalid quantity.' });
    const existing = items.find(i => i.id === product.id);
    if (existing) existing.quantity += quantity;
    else items.push({ id: product.id, name: product.name, price: product.price, quantity }); // price comes from the SERVER catalog
  }
  const total = items.reduce((sum, i) => sum + i.price * i.quantity, 0);

  const paymentMethod = PAYMENT_METHODS.includes(body.paymentMethod) ? body.paymentMethod : 'gcash';
  const paymentReference = clean(body.paymentReference, 60);

  const order = {
    id: '',
    createdAt: new Date().toISOString(),
    customer: { name, email, phone },
    event: {
      coupleNames: clean(body.event && body.event.coupleNames, 100),
      weddingDate: clean(body.event && body.event.weddingDate, 40),
      facebookLink: rawFb,
      content: clean(body.event && body.event.content, 1000)
    },
    items,
    total,
    paymentMethod,
    paymentReference,
    hasReceipt: false,
    status: paymentReference ? 'payment_submitted' : 'pending_payment',
    digitalDelivered: false,
    templateLinks: [],
    adminNotes: ''
  };

  let created = false;
  for (let attempt = 0; attempt < 6 && !created; attempt++) {
    order.id = newOrderId();
    created = await store.createOrder(order);
  }
  if (!created) throw new Error('Could not allocate an order code');

  notify(`New order ${order.id}`, `PHP ${total.toLocaleString('en-US')} - ${items.map(i => `${i.name} x${i.quantity}`).join(', ')} (${paymentMethod}${paymentReference ? ', ref sent' : ', no ref yet'})`);

  res.status(201).json({ success: true, orderId: order.id, total, order: trackingView(order) });
}));

function linksForOrder(order) {
  if (Array.isArray(order.templateLinks) && order.templateLinks.length) return order.templateLinks;
  return order.items
    .map(i => BY_ID.get(i.id))
    .filter(p => p && p.deliveryUrl)
    .map(p => ({ name: `${p.name} Canva Suite`, url: p.deliveryUrl }));
}
function trackingView(order) {
  const delivered = order.status === 'paid' || order.status === 'completed';
  return {
    id: order.id,
    createdAt: order.createdAt,
    status: order.status,
    total: order.total,
    customer: { name: order.customer.name, email: order.customer.email },
    event: order.event,
    items: order.items,
    paymentMethod: order.paymentMethod,
    paymentReference: order.paymentReference,
    hasReceipt: !!order.hasReceipt,
    templateLinks: delivered ? linksForOrder(order) : [], // links stay locked until paid
    canvaAccessUnlocked: delivered,
    guides: GUIDES
  };
}

app.get('/api/orders/:id', limitTrack, wrap(async (req, res) => {
  const id = String(req.params.id).trim().toUpperCase();
  const order = ORDER_ID_RE.test(id) ? await store.getOrder(id) : null;
  if (!order) return res.status(404).json({ error: 'Order not found with that tracking code.' });
  res.json(trackingView(order));
}));

// Payment proof (screenshot and/or reference number)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RECEIPT_BYTES, files: 1, fields: 6 },
  fileFilter: (req, file, cb) => cb(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype))
});
function receiptUpload(req, res, next) {
  upload.single('receipt')(req, res, err => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'That screenshot is too large (limit about 900 KB). Please crop or compress it and try again.' });
    }
    return res.status(400).json({ error: 'Could not read the uploaded file.' });
  });
}

app.post('/api/orders/:id/payment', limitPayment, receiptUpload, wrap(async (req, res) => {
  const id = String(req.params.id).trim().toUpperCase();
  const order = ORDER_ID_RE.test(id) ? await store.getOrder(id) : null;
  if (!order) return res.status(404).json({ error: 'Order not found.' });
  if (['paid', 'completed', 'cancelled'].includes(order.status)) {
    return res.status(409).json({ error: `This order is already ${order.status.replace('_', ' ')}.` });
  }

  const reference = clean(req.body && req.body.referenceNumber, 60);
  const method = req.body && req.body.paymentMethod;
  if (!reference && !req.file) {
    return res.status(400).json({ error: 'Please add a reference number or upload your payment screenshot.' });
  }

  if (req.file) {
    const kind = imageKind(req.file.buffer);
    if (!kind) return res.status(400).json({ error: 'Please upload a JPG, PNG or WEBP image.' });
    await store.putReceipt(order.id, { mime: kind, data: req.file.buffer.toString('base64') });
    order.hasReceipt = true;
  }
  if (reference) order.paymentReference = reference;
  if (PAYMENT_METHODS.includes(method)) order.paymentMethod = method;
  if (order.status === 'pending_payment') order.status = 'payment_submitted';
  await store.saveOrder(order);

  notify(`Payment proof for ${order.id}`, `PHP ${order.total.toLocaleString('en-US')} - ${order.customer.name} sent ${req.file ? 'a screenshot' : 'a reference number'}.`);

  res.json({ success: true, message: 'Payment verification details uploaded successfully.', order: trackingView(order) });
}));

app.post('/api/inquiries', limitInquiries, wrap(async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 100);
  const email = clean(b.email, 150);
  const message = clean(b.message, 2000);
  if (!name || !isEmail(email) || !message) {
    return res.status(400).json({ error: 'Please provide your name, a valid email, and your message.' });
  }
  const inquiry = {
    id: '',
    createdAt: new Date().toISOString(),
    name, email,
    eventType: clean(b.eventType, 60) || 'Wedding Template Inquiry',
    eventDate: clean(b.eventDate, 40),
    message,
    status: 'new'
  };
  let created = false;
  for (let attempt = 0; attempt < 6 && !created; attempt++) {
    inquiry.id = newInquiryId();
    created = await store.createInquiry(inquiry);
  }
  if (!created) throw new Error('Could not allocate an inquiry id');

  notify(`New inquiry from ${name.replace(/[^\x20-\x7E]/g, '')}`, message.slice(0, 200));
  res.status(201).json({ success: true, inquiryId: inquiry.id, message: 'Inquiry received. Khye will get back to you within 24 hours!' });
}));

/* ============================ ADMIN API ============================ */

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (ADMIN_ENABLED && verifyToken(token)) return next();
  return res.status(401).json({ error: 'Unauthorized: Invalid Admin Credentials' });
}

app.post('/api/admin/login', limitLogin, wrap(async (req, res) => {
  if (!ADMIN_ENABLED) {
    return res.status(503).json({ error: 'Admin login is turned off. Set the ADMIN_PIN environment variable (at least 8 characters).' });
  }
  const pin = typeof req.body.pin === 'string' ? req.body.pin : '';
  if (!safeEqual(pin, ADMIN_PIN)) return res.status(401).json({ error: 'Invalid admin PIN' });
  const settings = await store.getSettings();
  res.json({ success: true, token: signToken(), storeName: settings.storeName });
}));

app.get('/api/admin/stats', requireAdmin, wrap(async (req, res) => {
  const [orders, inquiries] = await Promise.all([store.listOrders(), store.listInquiries()]);
  const isPaid = o => o.status === 'paid' || o.status === 'completed';
  res.json({
    totalRevenue: orders.filter(isPaid).reduce((s, o) => s + (o.total || 0), 0),
    orderCount: orders.length,
    pendingOrders: orders.filter(o => o.status === 'pending_payment' || o.status === 'payment_submitted').length,
    paidOrders: orders.filter(isPaid).length,
    totalInquiries: inquiries.length,
    unreadInquiries: inquiries.filter(i => i.status === 'new').length
  });
}));

app.get('/api/admin/orders', requireAdmin, wrap(async (req, res) => {
  let list = await store.listOrders();
  if (req.query.status && req.query.status !== 'all') list = list.filter(o => o.status === req.query.status);
  res.json(list);
}));

app.get('/api/admin/orders/:id/receipt', requireAdmin, wrap(async (req, res) => {
  const receipt = await store.getReceipt(String(req.params.id).toUpperCase());
  if (!receipt) return res.status(404).json({ error: 'No receipt uploaded.' });
  res.set({ 'Content-Type': receipt.mime, 'Cache-Control': 'private, no-store' });
  res.send(Buffer.from(receipt.data, 'base64'));
}));

app.patch('/api/admin/orders/:id', requireAdmin, wrap(async (req, res) => {
  const order = await store.getOrder(String(req.params.id).toUpperCase());
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const { status, adminNotes, digitalDelivered, templateLinks } = req.body || {};

  if (status !== undefined) {
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    order.status = status;
  }
  if (adminNotes !== undefined) order.adminNotes = clean(String(adminNotes), 2000);
  if (digitalDelivered !== undefined) order.digitalDelivered = !!digitalDelivered;
  if (templateLinks !== undefined) {
    if (!Array.isArray(templateLinks) || templateLinks.length > 10 ||
        !templateLinks.every(l => l && clean(l.name, 100) && isHttpUrl(l.url))) {
      return res.status(400).json({ error: 'Delivery links must be full web addresses (https://...).' });
    }
    order.templateLinks = templateLinks.map(l => ({ name: clean(l.name, 100), url: l.url.trim() }));
  }
  await store.saveOrder(order);
  res.json({ success: true, order });
}));

app.delete('/api/admin/orders/:id', requireAdmin, wrap(async (req, res) => {
  const ok = await store.deleteOrder(String(req.params.id).toUpperCase());
  if (!ok) return res.status(404).json({ error: 'Order not found' });
  res.json({ success: true, message: 'Order deleted successfully' });
}));

app.get('/api/admin/inquiries', requireAdmin, wrap(async (req, res) => {
  res.json(await store.listInquiries());
}));

app.patch('/api/admin/inquiries/:id', requireAdmin, wrap(async (req, res) => {
  const inq = await store.getInquiry(String(req.params.id));
  if (!inq) return res.status(404).json({ error: 'Inquiry not found' });
  if (['new', 'replied'].includes(req.body && req.body.status)) inq.status = req.body.status;
  await store.saveInquiry(inq);
  res.json({ success: true, inquiry: inq });
}));

app.put('/api/admin/settings', requireAdmin, wrap(async (req, res) => {
  const current = await store.getSettings();
  const next = { ...current };
  for (const key of SETTINGS_KEYS) {
    if (typeof (req.body || {})[key] === 'string') next[key] = clean(req.body[key], 120);
  }
  delete next.adminPin; // the PIN is controlled by the ADMIN_PIN environment variable only
  await store.putSettings(next);
  res.json({ success: true, settings: next });
}));

/* ============================ ERRORS ============================ */

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res) => res.status(404).type('text').send('Page not found'));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof store.StoreUnavailable) {
    return res.status(503).json({
      error: 'We can\u2019t save that right now. Please message us on Facebook and we\u2019ll help you directly.'
    });
  }
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
    return res.status(400).json({ error: 'Invalid request.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\u2726 Khyxx Digitals running on http://localhost:${PORT} (storage: ${store.MODE}) \u2726`);
  });
}

module.exports = app;
