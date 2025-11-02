// backend/server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// -------- Static (landing + purchase) --------
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// -------- ENV --------
const {
  PORT = 4000,
  EVENT_NAME = 'Soirée AFARIS – Décembre 2025',
  EVENT_DATE = '2025-12-27',
  ORGANIZER_EMAIL = 'billets@afaris.com',

  // Paiement (si tu gardes PayPal simulé)
  PAYPAL_ENV = 'sandbox',
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,

  // Provider e-mail (choisis)
  // -> RESEND (recommandé) OU SMTP
  MAIL_PROVIDER = 'RESEND',          // 'RESEND' | 'SMTP'

  // Resend
  RESEND_API_KEY,
  FROM_EMAIL,                        // ex: billets@afaris.com (ou un sender Resend validé)

  // SMTP (Brevo / SendGrid / SES…)
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,

  // Virement
  IBAN,
  BIC,

  // JWT
  JWT_SECRET = 'dev_secret',
} = process.env;

// -------- Stores en mémoire --------
const tickets = new Map();
const reservations = new Map();

// -------- Helper JWT --------
function signTicketPayload(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

// -------- Mailer provider-agnostic --------
let EMAILS_ENABLED = true;
let transporter = null;
let resend = null;

async function mailInit() {
  try {
    if (MAIL_PROVIDER === 'RESEND') {
      if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY manquant');
      resend = new Resend(RESEND_API_KEY);
      console.log('📧 Mail: RESEND actif');
      return;
    }

    // SMTP fallback
    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
      throw new Error('SMTP incomplet');
    }
    const p = Number(SMTP_PORT);
    const secure = p === 465;
    transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: p,
      secure,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 20_000,
    });
    await transporter.verify();
    console.log(`📧 Mail: SMTP actif (${SMTP_HOST}:${p})`);
  } catch (e) {
    EMAILS_ENABLED = false;
    console.error('❌ Mail init:', e.message);
  }
}
(async () => { await mailInit(); })();

// petit check
app.get('/api/smtp-check', (req, res) => {
  res.json({
    emailsEnabled: EMAILS_ENABLED,
    provider: MAIL_PROVIDER,
    host: SMTP_HOST || null,
    user: SMTP_USER || null,
    from: FROM_EMAIL || ORGANIZER_EMAIL || SMTP_USER || null
  });
});

// envoi unifié
async function sendHtmlEmail(to, subject, html) {
  if (!EMAILS_ENABLED) throw new Error('Emails désactivés');
  const from = FROM_EMAIL || ORGANIZER_EMAIL || SMTP_USER;

  if (resend) {
    const result = await resend.emails.send({ from, to, subject, html });
    if (result.error) throw new Error(result.error.message || 'Resend error');
    return result;
  }
  if (transporter) {
    return transporter.sendMail({ from, to, subject, html });
  }
  throw new Error('Aucun provider mail disponible');
}

// -------- PayPal helpers (facultatif / simulé) --------
async function getPayPalAccessToken() {
  const url =
    PAYPAL_ENV === 'live'
      ? 'https://api-m.paypal.com/v1/oauth2/token'
      : 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
  const res = await axios({
    url,
    method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_SECRET },
    data: 'grant_type=client_credentials',
  });
  return res.data.access_token;
}

async function capturePayPalOrder(orderId) {
  const base =
    PAYPAL_ENV === 'live'
      ? 'https://api-m.paypal.com'
      : 'https://api-m.sandbox.paypal.com';
  const token = await getPayPalAccessToken();
  const res = await axios.post(
    `${base}/v2/checkout/orders/${orderId}/capture`,
    {},
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  return res.data;
}

// -------- Emails métiers --------
async function sendTicketEmail(to, ticket) {
  if (!EMAILS_ENABLED) throw new Error('SMTP/Resend disabled');

  const htmlTemplate = fs.readFileSync(
    path.join(__dirname, 'ticketTemplate.html'),
    'utf8'
  );
  const qrDataUrl = await QRCode.toDataURL(ticket.jwt);
  const html = htmlTemplate
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, ticket.name)
    .replace(/{{TICKET_ID}}/g, ticket.id)
    .replace(/{{TICKET_TYPE}}/g, ticket.type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard (sans menu)')
    .replace(/{{QR_DATA_URL}}/g, qrDataUrl);

  await sendHtmlEmail(to, `[${EVENT_NAME}] Votre billet – ${ticket.id}`, html);
}

async function sendTransferReservationEmail(to, reservation) {
  if (!EMAILS_ENABLED) throw new Error('SMTP/Resend disabled');

  const htmlTemplate = fs.readFileSync(
    path.join(__dirname, '..', 'emails', 'transferReservation.html'),
    'utf8'
  );
  const html = htmlTemplate
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, reservation.name)
    .replace(/{{AMOUNT}}/g, reservation.amount.toFixed(2))
    .replace(/{{REFERENCE}}/g, reservation.referenceCode)
    .replace(/{{IBAN}}/g, IBAN || '—')
    .replace(/{{BIC}}/g, BIC || '—');

  await sendHtmlEmail(to, `[${EVENT_NAME}] Réservation en attente de virement (${reservation.referenceCode})`, html);
}

// -------- API --------
app.get('/api/health', (req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), uptime: process.uptime() })
);

// Créer commande (virement ou carte)
app.post('/api/create-order', async (req, res) => {
  const { name, email, ticketType, amount, method } = req.body; // 'standard' | 'vip'
  if (!name || !email || !ticketType || !amount || !method)
    return res.status(400).json({ error: 'Missing fields' });

  if (method === 'transfer') {
    const referenceCode = `AFR-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
    const reservation = {
      email,
      name,
      ticketType,
      amount: Number(amount),
      referenceCode,
      createdAt: Date.now(),
      status: 'pending_transfer',
    };
    reservations.set(referenceCode, reservation);
    try { await sendTransferReservationEmail(email, reservation); }
    catch (e) { console.error('Email error:', e.message); }
    return res.json({ ok: true, method, referenceCode, iban: IBAN, bic: BIC });
  }

  if (method === 'card') {
    // MVP : simule une order PayPal
    const orderId = uuidv4();
    return res.json({ ok: true, method, orderId });
  }

  return res.status(400).json({ error: 'Invalid method' });
});

// Capture PayPal (simulé)
app.post('/api/paypal/capture', async (req, res) => {
  const { orderId, name, email, amount, ticketType } = req.body;
  if (!orderId || !name || !email || !amount || !ticketType)
    return res.status(400).json({ error: 'Missing fields' });

  try {
    // const capture = await capturePayPalOrder(orderId);
    // if (capture.status !== 'COMPLETED') return res.status(400).json({ error: 'Payment not completed' });

    const id = `AFR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const payload = { id, email, name, amount: Number(amount), type: ticketType, issuedAt: Date.now(), source: 'paypal' };
    const token = signTicketPayload(payload);
    const ticket = { id, email, name, amount: Number(amount), type: ticketType, method: 'card', status: 'valid', jwt: token, createdAt: Date.now() };
    tickets.set(id, ticket);
    try { await sendTicketEmail(email, ticket); }
    catch (e) { console.error('Email error:', e.message); }
    return res.json({ ok: true, ticketId: id });
  } catch (e) {
    console.error('capture error', e.message);
    return res.status(500).json({ error: 'Capture failed' });
  }
});

// Confirmation virement (quand payé)
app.post('/api/confirm-transfer', async (req, res) => {
  const { referenceCode, name, email, amount, ticketType } = req.body;
  const r = reservations.get(referenceCode);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });

  r.status = 'paid';
  const id = `AFR-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const payload = { id, email, name, amount: Number(amount || r.amount), type: ticketType || r.ticketType, issuedAt: Date.now(), reference: referenceCode };
  const token = signTicketPayload(payload);
  const ticket = { id, email, name, amount: Number(amount || r.amount), type: ticketType || r.ticketType, method: 'transfer', status: 'valid', jwt: token, createdAt: Date.now() };
  tickets.set(id, ticket);

  try { await sendTicketEmail(email, ticket); }
  catch (e) { console.error('Email error:', e.message); }

  return res.json({ ok: true, ticketId: id });
});

// Scanner / validation
app.post('/api/validate', (req, res) => {
  const { token } = req.body;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const t = tickets.get(decoded.id);
    if (!t) return res.status(404).json({ ok: false, reason: 'Ticket not found' });
    if (t.status === 'used') return res.status(400).json({ ok: false, reason: 'Already used' });
    t.status = 'used';
    tickets.set(t.id, t);
    return res.json({ ok: true, ticketId: t.id, name: t.name, type: t.type });
  } catch (e) {
    return res.status(400).json({ ok: false, reason: 'Invalid or expired QR' });
  }
});

/* ========= ROUTES DE TEST (diagnostic) ========= */

// POST JSON {to}
app.post('/api/test-email', express.json(), async (req, res) => {
  try {
    if (!EMAILS_ENABLED) return res.status(400).json({ ok: false, error: 'Emails OFF' });
    const { to } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: 'missing "to"' });
    const info = await sendHtmlEmail(to, '[AFARIS] Test email', `<p>✅ Test e-mail OK.</p><p>${new Date().toISOString()}</p>`);
    res.json({ ok: true, info: info?.id || info?.messageId || 'sent' });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST JSON {to, type, name}
app.post('/api/test-ticket', express.json(), async (req, res) => {
  try {
    if (!EMAILS_ENABLED) return res.status(400).json({ ok: false, error: 'Emails OFF' });
    const { to, type = 'standard', name = 'Test AFARIS' } = req.body || {};
    if (!to) return res.status(400).json({ ok: false, error: 'missing "to"' });

    const id = `AFR-TEST-${Date.now()}`;
    const amount = type === 'vip' ? 40 : 25;
    const payload = { id, email: to, name, amount, type, issuedAt: Date.now(), source: 'test' };
    const token = signTicketPayload(payload);
    const ticket = { id, email: to, name, amount, type, method: 'test', status: 'valid', jwt: token, createdAt: Date.now() };

    await sendTicketEmail(to, ticket);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Versions GET (pratiques dans le navigateur)
app.get('/api/test-email-get', async (req, res) => {
  try {
    if (!EMAILS_ENABLED) return res.status(400).send('Emails OFF');
    const to = req.query.to;
    if (!to) return res.status(400).send('missing ?to=');
    await sendHtmlEmail(to, '[AFARIS] Test email (GET)', `<p>✅ Test GET OK.</p><p>${new Date().toISOString()}</p>`);
    res.send('OK (email envoyé)');
  } catch (e) {
    res.status(500).send('Erreur: ' + (e.message || e));
  }
});

app.get('/api/test-ticket-get', async (req, res) => {
  try {
    if (!EMAILS_ENABLED) return res.status(400).send('Emails OFF');
    const to = req.query.to;
    const type = req.query.type === 'vip' ? 'vip' : 'standard';
    const name = req.query.name || 'Test AFARIS';
    if (!to) return res.status(400).send('missing ?to=');

    const id = `AFR-TEST-${Date.now()}`;
    const amount = type === 'vip' ? 40 : 25;
    const payload = { id, email: to, name, amount, type, issuedAt: Date.now(), source: 'test-get' };
    const token = signTicketPayload(payload);
    const htmlTemplate = fs.readFileSync(path.join(__dirname, 'ticketTemplate.html'), 'utf8');
    const qrDataUrl = await QRCode.toDataURL(token);
    const html = htmlTemplate
      .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
      .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
      .replace(/{{NAME}}/g, name)
      .replace(/{{TICKET_ID}}/g, id)
      .replace(/{{TICKET_TYPE}}/g, type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard (sans menu)')
      .replace(/{{QR_DATA_URL}}/g, qrDataUrl);

    await sendHtmlEmail(to, `[${EVENT_NAME}] Votre billet – ${id}`, html);
    res.send(`OK, billet envoyé à ${to} (id=${id})`);
  } catch (e) {
    res.status(500).send('Erreur: ' + (e.message || e));
  }
});

// Liste des routes dispo (debug)
app.get('/__routes', (req, res) => {
  const routes = [];
  app._router.stack.forEach(mw => {
    if (mw.route && mw.route.path) {
      routes.push({ path: mw.route.path, methods: Object.keys(mw.route.methods) });
    }
  });
  res.json(routes);
});

// -------- Start --------
app.listen(PORT, () => console.log('🚀 AFARIS backend on', PORT, `(${MAIL_PROVIDER})`));
