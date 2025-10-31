
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// Serve static files (landing + purchase) from ../public
app.use('/', express.static(path.join(__dirname, '..', 'public')));

const {
  PORT = 4000,
  EVENT_NAME = 'Soirée AFARIS – Décembre 2025',
  EVENT_DATE = '2025-12-27',
  ORGANIZER_EMAIL = 'billets@afaris.com',
  PAYPAL_ENV = 'sandbox',
  PAYPAL_CLIENT_ID,
  PAYPAL_SECRET,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  IBAN,
  BIC,
  JWT_SECRET = 'dev_secret',
} = process.env;

const tickets = new Map();
const reservations = new Map();

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 587),
  secure: false,
  auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
});

function signTicketPayload(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
}

async function getPayPalAccessToken() {
  const url = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com/v1/oauth2/token' : 'https://api-m.sandbox.paypal.com/v1/oauth2/token';
  const res = await axios({
    url, method: 'post',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    auth: { username: PAYPAL_CLIENT_ID, password: PAYPAL_SECRET },
    data: 'grant_type=client_credentials',
  });
  return res.data.access_token;
}

async function capturePayPalOrder(orderId) {
  const base = PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  const token = await getPayPalAccessToken();
  const res = await axios.post(`${base}/v2/checkout/orders/${orderId}/capture`, {}, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  });
  return res.data;
}

async function sendTicketEmail(to, ticket) {
  const htmlTemplate = fs.readFileSync(path.join(__dirname, 'ticketTemplate.html'), 'utf8');
  const qrDataUrl = await QRCode.toDataURL(ticket.jwt);
  const html = htmlTemplate
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, ticket.name)
    .replace(/{{TICKET_ID}}/g, ticket.id)
    .replace(/{{TICKET_TYPE}}/g, ticket.type === 'vip' ? 'Entrée VIP (menu compris)' : 'Entrée Standard')
    .replace(/{{QR_DATA_URL}}/g, qrDataUrl);
  await transporter.sendMail({
    from: ORGANIZER_EMAIL,
    to,
    subject: `[${EVENT_NAME}] Votre billet – ${ticket.id}`,
    html,
  });
}

async function sendTransferReservationEmail(to, reservation) {
  const htmlTemplate = fs.readFileSync(path.join(__dirname, '..', 'emails', 'transferReservation.html'), 'utf8');
  const html = htmlTemplate
    .replace(/{{EVENT_NAME}}/g, EVENT_NAME)
    .replace(/{{EVENT_DATE}}/g, EVENT_DATE)
    .replace(/{{NAME}}/g, reservation.name)
    .replace(/{{AMOUNT}}/g, reservation.amount.toFixed(2))
    .replace(/{{REFERENCE}}/g, reservation.referenceCode)
    .replace(/{{IBAN}}/g, IBAN || '—')
    .replace(/{{BIC}}/g, BIC || '—');
  await transporter.sendMail({
    from: ORGANIZER_EMAIL,
    to,
    subject: `[${EVENT_NAME}] Réservation en attente de virement (${reservation.referenceCode})`,
    html,
  });
}

app.get('/api/health', (req,res)=>res.json({ok:true,time:new Date().toISOString()}));

app.post('/api/create-order', async (req,res)=>{
  const { name, email, ticketType, amount, method } = req.body; // ticketType: 'standard' | 'vip'
  if(!name || !email || !ticketType || !amount || !method) return res.status(400).json({error:'Missing fields'});

  if (method === 'transfer') {
    const referenceCode = `AFR-${new Date().getFullYear()}-${String(Math.floor(Math.random()*100000)).padStart(5,'0')}`;
    const reservation = { email, name, ticketType, amount: Number(amount), referenceCode, createdAt: Date.now(), status:'pending_transfer' };
    reservations.set(referenceCode, reservation);
    try{ await sendTransferReservationEmail(email, reservation); }catch(e){ console.error('Email error:', e.message); }
    return res.json({ ok:true, method, referenceCode, iban: IBAN, bic: BIC });
  }

  if (method === 'card') {
    // Normally create PayPal order via API; simplified for MVP
    const orderId = uuidv4();
    return res.json({ ok:true, method, orderId });
  }

  return res.status(400).json({error:'Invalid method'});
});

app.post('/api/paypal/capture', async (req,res)=>{
  const { orderId, name, email, amount, ticketType } = req.body;
  if(!orderId || !name || !email || !amount || !ticketType) return res.status(400).json({error:'Missing fields'});
  try{
    // const capture = await capturePayPalOrder(orderId); if(capture.status!=='COMPLETED') return res.status(400).json({error:'Payment not completed'});
    const id = `AFR-${Date.now()}-${Math.floor(Math.random()*1000)}`;
    const payload = { id, email, name, amount:Number(amount), type: ticketType, issuedAt: Date.now(), source:'paypal' };
    const token = signTicketPayload(payload);
    const ticket = { id, email, name, amount:Number(amount), type: ticketType, method:'card', status:'valid', jwt: token, createdAt: Date.now() };
    tickets.set(id, ticket);
    try{ await sendTicketEmail(email, ticket); }catch(e){ console.error('Email error:', e.message); }
    return res.json({ ok:true, ticketId:id });
  }catch(e){
    console.error('capture error', e.message);
    return res.status(500).json({error:'Capture failed'});
  }
});

app.post('/api/confirm-transfer', async (req,res)=>{
  const { referenceCode, name, email, amount, ticketType } = req.body;
  const r = reservations.get(referenceCode);
  if(!r) return res.status(404).json({error:'Reservation not found'});
  r.status = 'paid';
  const id = `AFR-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const payload = { id, email, name, amount:Number(amount||r.amount), type: ticketType || r.ticketType, issuedAt: Date.now(), reference: referenceCode };
  const token = signTicketPayload(payload);
  const ticket = { id, email, name, amount:Number(amount||r.amount), type: (ticketType||r.ticketType), method:'transfer', status:'valid', jwt: token, createdAt: Date.now() };
  tickets.set(id, ticket);
  try{ await sendTicketEmail(email, ticket); }catch(e){ console.error('Email error:', e.message); }
  return res.json({ ok:true, ticketId:id });
});

app.post('/api/validate', (req,res)=>{
  const { token } = req.body;
  try{
    const decoded = jwt.verify(token, JWT_SECRET);
    const t = tickets.get(decoded.id);
    if(!t) return res.status(404).json({ ok:false, reason:'Ticket not found' });
    if(t.status==='used') return res.status(400).json({ ok:false, reason:'Already used' });
    t.status = 'used'; tickets.set(t.id, t);
    return res.json({ ok:true, ticketId:t.id, name:t.name, type:t.type });
  }catch(e){
    return res.status(400).json({ ok:false, reason:'Invalid or expired QR' });
  }
});

app.listen(PORT, ()=>console.log('AFARIS all-in-one running on port', PORT));
