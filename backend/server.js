require('dotenv').config();
const { Resend } = require('resend');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// --------- Static front (landing + purchase) ---------
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// --------- ENV ----------
const {
  PORT = 4000,
  EVENT_NAME = 'Soirée AFARIS – Décembre 2025',
  EVENT_DATE = '2025-12-27',
  ORGANIZER_EMAIL = 'billets@afaris.com',

  // (option PayPal simulée)
  PAYPAL_ENV = 'sandbox',
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,

  IBAN,
  BIC,

  JWT_SECRET = 'dev_secret',

  // E-mail provider (Resend)
  MAIL_PROVIDER = 'RESEND',
  RESEND_API_KEY,
  FROM_EMAIL, // DOIT être validée dans Resend
} = process.env;

// --------- Stores mémoire ----------
const tickets = new Map();       // billets émis
const reservations = new Map();  // réservations virement

// --------- Email Provider (Resend) ----------
let EMAILS_ENABLED = false;
let resend = null;

(function initMail() {
  if ((MAIL_PROVIDER || '').toUpperCase() !== 'RESEND') {
    console.warn('📭 MAIL_PROVIDER ≠ RESEND → e-mails désactivés');
    EMAILS_ENABLED = false;
    return;
  }
  if (!RESEND_API_KEY || !FROM_EMAIL) {
    console.warn('📭 RESEND_API_KEY ou FROM_EMAIL manquants → e-mails désactivés');
    EMAILS_ENABLED = false;
    return;
  }
  resend = new Resend(RESEND_API_KEY);
  EMAILS_ENABLED = true;
  console.log('📬 Using Resend provider (no SMTP). Email system ready.');
})();

app.get('/api/smtp-check', (_req, res) => {
  res.json({
    emailsEnabled: EMAILS_ENABLED,
    provider: EMAILS_ENABLED ? 'resend' : null,
    from: FROM_EMAIL || null,
  });
});

// --------- Helpers ----------
function signTicketPayload(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

async function sendEmailHTML(to, subject, html) {
  if (!EMAILS_ENABLED || !resend) throw new Error('EMAIL_DISABLED');
  const resp = await resend.emails.send({
    from: FROM_EMAIL, // adresse validée chez Resend
    to,
    subject,
    html,
  });
  if (resp?.error) throw new Error(resp.error.message || 'Resend error');
  return resp;
}

async function sendTicketEmail(to, ticket) {
  if (!EMAILS_ENABLED) throw new Error('EMAIL_DISABLED');

  const templatePath = path.join(__dirname, 'ticketTemplate.html');
  const htmlTpl = fs.readFileSync(templatePath, 'utf8');

  const qrDataUrl = await QRCode.toDataURL(ticket.jwt);

  const html = htmlTpl
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, ticket.name)
    .replace(/{{TICKET_ID}}/g, ticket.id)
    .replace(/{{TICKET_TYPE}}/g, ticket.type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard (sans menu)')
    .replace(/{{QR_DATA_URL}}/g, qrDataUrl);

  await sendEmailHTML(to, `[${EVENT_NAME}] Votre billet – ${ticket.id}`, html);
}

async function sendTransferReservationEmail(to, reservation) {
  if (!EMAILS_ENABLED) throw new Error('EMAIL_DISABLED');

  const templatePath = path.join(__dirname, '..', 'emails', 'transferReservation.html');
  const htmlTpl = fs.readFileSync(templatePath, 'utf8');

  const html = htmlTpl
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, reservation.name)
    .replace(/{{AMOUNT}}/g, reservation.amount.toFixed(2))
    .replace(/{{REFERENCE}}/g, reservation.referenceCode)
    .replace(/{{IBAN}}/g, IBAN || '—')
    .replace(/{{BIC}}/g, BIC || '—');

  await sendEmailHTML(to, `[${EVENT_NAME}] Réservation en attente de virement (${reservation.referenceCode})`, html);
}

// --------- Health ----------
app.get('/api/health', (_req, res) =>
  res.json({ ok: true, time: new Date().toISOString(), email: EMAILS_ENABLED ? 'resend' : 'off' })
);

// --------- Create order (virement ou carte) ----------
app.post('/api/create-order', async (req, res) => {
  const { name, email, ticketType, amount, method } = req.body;
  if (!name || !email || !ticketType || !amount || !method) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  if (method === 'transfer') {
    const referenceCode = `AFR-${new Date().getFullYear()}-${String(Math.floor(Math.random()*100000)).padStart(5,'0')}`;
    const reservation = {
      email, name, ticketType,
      amount: Number(amount),
      referenceCode,
      createdAt: Date.now(),
      status: 'pending_transfer',
    };
    reservations.set(referenceCode, reservation);

    try { await sendTransferReservationEmail(email, reservation); }
    catch (e) { console.error('Email error (transfer):', e.message); }

    return res.json({ ok: true, method, referenceCode, iban: IBAN, bic: BIC });
  }

  if (method === 'card') {
    // MVP : simuler une order PayPal (si tu veux la vraie intégration, appelle l’API PayPal)
    const orderId = uuidv4();
    return res.json({ ok: true, method, orderId });
  }

  return res.status(400).json({ error: 'Invalid method' });
});

// --------- Capture (carte) – version simulée ----------
app.post('/api/paypal/capture', async (req, res) => {
  const { orderId, name, email, amount, ticketType } = req.body;
  if (!orderId || !name || !email || !amount || !ticketType) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  try {
    const id = `AFR-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const payload = { id, email, name, amount:Number(amount), type: ticketType, issuedAt: Date.now(), source: 'paypal' };
    const token = signTicketPayload(payload);
    const ticket = { id, email, name, amount:Number(amount), type: ticketType, method:'card', status:'valid', jwt: token, createdAt: Date.now() };

    tickets.set(id, ticket);
    try { await sendTicketEmail(email, ticket); } catch (e) { console.error('Email error (ticket):', e.message); }

    return res.json({ ok: true, ticketId: id });
  } catch (e) {
    console.error('capture error', e.message);
    return res.status(500).json({ error: 'Capture failed' });
  }
});

// --------- Confirmer un virement (quand tu reçois l’argent) ----------
app.post('/api/confirm-transfer', async (req, res) => {
  const { referenceCode, name, email, amount, ticketType } = req.body;
  const r = reservations.get(referenceCode);
  if (!r) return res.status(404).json({ error: 'Reservation not found' });

  r.status = 'paid';

  const id = `AFR-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const payload = {
    id, email, name,
    amount: Number(amount || r.amount),
    type: ticketType || r.ticketType,
    issuedAt: Date.now(),
    reference: referenceCode
  };
  const token = signTicketPayload(payload);
  const ticket = {
    id, email, name,
    amount: Number(amount || r.amount),
    type: ticketType || r.ticketType,
    method: 'transfer',
    status: 'valid',
    jwt: token,
    createdAt: Date.now(),
  };

  tickets.set(id, ticket);
  try { await sendTicketEmail(email, ticket); } catch (e) { console.error('Email error (ticket):', e.message); }
  return res.json({ ok: true, ticketId: id });
});

// --------- Scanner / Validation ----------
app.post('/api/validate', (req, res) => {
  const { token } = req.body;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const t = tickets.get(decoded.id);
    if (!t) return res.status(404).json({ ok:false, reason:'Ticket not found' });
    if (t.status === 'used') return res.status(400).json({ ok:false, reason:'Already used' });

    t.status = 'used'; tickets.set(t.id, t);
    return res.json({ ok:true, ticketId:t.id, name:t.name, type:t.type });
  } catch (e) {
    return res.status(400).json({ ok:false, reason:'Invalid or expired QR' });
  }
});

// --------- Routes de test (GET) ----------
app.get('/api/test-email-get', async (req, res) => {
  try {
    if (!EMAILS_ENABLED) return res.status(400).send('Emails désactivés');
    const to = req.query.to;
    if (!to) return res.status(400).send('Paramètre ?to= requis');
    const html = `<p>✅ Test e-mail via Resend OK.</p><p>${new Date().toISOString()}</p>`;
    const out = await sendEmailHTML(to, '[AFARIS] Test email (GET)', html);
    res.send(`OK, messageId=${out?.data?.id || 'sent'}`);
  } catch (e) {
    res.status(500).send('Erreur: ' + (e.message || e));
  }
});

app.get('/api/test-ticket-get', async (req, res) => {
  try {
    if (!EMAILS_ENABLED) return res.status(400).send('Emails désactivés');
    const to = req.query.to;
    const type = (req.query.type === 'vip') ? 'vip' : 'standard';
    const name = req.query.name || 'Test AFARIS';
    if (!to) return res.status(400).send('Paramètre ?to= requis');

    const id = `AFR-TEST-${Date.now()}`;
    const amount = type === 'vip' ? 40 : 25;
    const payload = { id, email: to, name, amount, type, issuedAt: Date.now(), source: 'test-get' };
    const token = signTicketPayload(payload);

    const tpl = fs.readFileSync(path.join(__dirname, 'ticketTemplate.html'), 'utf8');
    const qr = await QRCode.toDataURL(token);
    const html = tpl
      .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
      .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
      .replace(/{{NAME}}/g, name)
      .replace(/{{TICKET_ID}}/g, id)
      .replace(/{{TICKET_TYPE}}/g, type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard (sans menu)')
      .replace(/{{QR_DATA_URL}}/g, qr);

    await sendEmailHTML(to, `[${EVENT_NAME}] Votre billet – ${id}`, html);
    res.send(`OK, billet envoyé à ${to} (id=${id})`);
  } catch (e) {
    res.status(500).send('Erreur: ' + (e.message || e));
  }
});

// --------- Start ----------
app.listen(PORT, () => {
  console.log(`🚀 AFARIS backend on ${PORT} (Resend emails=${EMAILS_ENABLED})`);
});
