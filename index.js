'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');
const crypto = require('crypto');
const fs = require('fs');

// ---------- Configuration ----------
const AUTH_DIR       = process.env.AUTH_DIR        || './auth';
const PREFIX         = process.env.PREFIX          || '!';
const BOT_NAME       = process.env.BOT_NAME        || 'Pheizu Bot';
const RECONNECT_MS   = Number(process.env.RECONNECT_MS) || 3000;

const OTP_LENGTH     = Number(process.env.OTP_LENGTH)     || 6;
const OTP_TTL_MS     = Number(process.env.OTP_TTL_MS)     || 5 * 60 * 1000;   // 5 min
const OTP_COOLDOWN   = Number(process.env.OTP_COOLDOWN)   || 60 * 1000;       // 60 sec
const OTP_MAX_TRIES  = Number(process.env.OTP_MAX_TRIES)  || 3;

// File paths for cPanel integration
const PAIRING_PHONE_FILE = './pairing_request.txt';
const PAIRING_STATUS_FILE = './pairing_status.json';

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

let sock = null;
let starting = false;

// ---------- In-Memory OTP Store ----------
const otps = new Map();
const lastIssued = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [phone, rec] of otps) {
    if (rec.expiresAt < now) otps.delete(phone);
  }
}, 60 * 1000).unref();

// ---------- Helpers ----------
function extractText(m) {
  const msg = m.message || {};
  return (
    msg.conversation ||
    msg.extendedTextMessage?.text ||
    msg.imageMessage?.caption ||
    msg.videoMessage?.caption ||
    ''
  ).trim();
}

async function reply(jid, quoted, text) {
  if (!sock) return;
  await sock.sendMessage(jid, { text }, { quoted });
  await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
}

function normalizePhone(input) {
  let digits = String(input).replace(/\D/g, '');
  if (digits.length === 10) {
    digits = '91' + digits; // Defaults to India country code if 10 digits
  }
  if (digits.length < 10 || digits.length > 15) return null;
  return digits;
}

function toJid(phone) {
  return `${phone}@s.whatsapp.net`;
}

function generateOtp() {
  const max = 10 ** OTP_LENGTH;
  const min = 10 ** (OTP_LENGTH - 1);
  return String(crypto.randomInt(min, max));
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// ---------- Update State Files for PHP/cPanel ----------
function updateStatusFile(status, data = {}) {
  try {
    fs.writeFileSync(PAIRING_STATUS_FILE, JSON.stringify({
      status,
      timestamp: Date.now(),
      ...data
    }, null, 2));
  } catch (e) {}
}

// ---------- OTP Core ----------
async function issueOtp(phone) {
  const now = Date.now();
  const last = lastIssued.get(phone) || 0;
  if (now - last < OTP_COOLDOWN) {
    const wait = Math.ceil((OTP_COOLDOWN - (now - last)) / 1000);
    return { ok: false, reason: `Please wait ${wait}s before requesting a new OTP.` };
  }

  const code = generateOtp();
  otps.set(phone, { code, expiresAt: now + OTP_TTL_MS, tries: 0 });
  lastIssued.set(phone, now);

  try {
    await sock.sendMessage(toJid(phone), {
      text: `*${BOT_NAME}*\n\nYour verification code is: *${code}*\n\nValid for: ${Math.round(OTP_TTL_MS / 60000)} minutes.\nDo not share this code with anyone.`,
    });
  } catch (err) {
    otps.delete(phone);
    lastIssued.delete(phone);
    return { ok: false, reason: `Delivery error: ${err.message}` };
  }

  return { ok: true, expiresInSec: Math.round(OTP_TTL_MS / 1000) };
}

function verifyOtp(phone, code) {
  const rec = otps.get(phone);
  if (!rec) return { ok: false, reason: 'No active OTP found for this number.' };
  if (Date.now() > rec.expiresAt) {
    otps.delete(phone);
    return { ok: false, reason: 'OTP has expired.' };
  }
  if (rec.tries >= OTP_MAX_TRIES) {
    otps.delete(phone);
    return { ok: false, reason: 'Too many failed attempts. Request a new code.' };
  }

  rec.tries += 1;

  if (!safeEqual(rec.code, code)) {
    const left = OTP_MAX_TRIES - rec.tries;
    if (left <= 0) {
      otps.delete(phone);
      return { ok: false, reason: 'Incorrect code. Attempts exhausted.' };
    }
    return { ok: false, reason: `Incorrect code. ${left} attempt(s) remaining.` };
  }

  otps.delete(phone);
  return { ok: true };
}

// ---------- WhatsApp Commands ----------
const commands = {
  async ping({ jid, m }) {
    const t = Date.now();
    await reply(jid, m, `pong 🏓 (${Date.now() - t} ms)`);
  },
  async help({ jid, m }) {
    await reply(jid, m, `*${BOT_NAME}*\nCommands: ${PREFIX}otp <phone>, ${PREFIX}verify <phone> <code>`);
  },
  async otp({ jid, m, args }) {
    if (!args.length) return reply(jid, m, `Usage: ${PREFIX}otp <phone>`);
    const phone = normalizePhone(args[0]);
    if (!phone) return reply(jid, m, 'Invalid phone number format.');
    const res = await issueOtp(phone);
    if (!res.ok) return reply(jid, m, `❌ ${res.reason}`);
    await reply(jid, m, `✅ OTP dispatched to +${phone}.`);
  },
  async verify({ jid, m, args }) {
    if (args.length < 2) return reply(jid, m, `Usage: ${PREFIX}verify <phone> <code>`);
    const phone = normalizePhone(args[0]);
    const code  = String(args[1]).trim();
    if (!phone) return reply(jid, m, 'Invalid phone number format.');
    const res = verifyOtp(phone, code);
    if (!res.ok) return reply(jid, m, `❌ ${res.reason}`);
    await reply(jid, m, `✅ Phone number +${phone} successfully verified!`);
  }
};

async function handleMessage(m) {
  if (!m.message || m.key.fromMe) return;
  const jid = m.key.remoteJid;
  if (!jid || jid.includes('broadcast')) return;

  const text = extractText(m);
  if (!text || !text.startsWith(PREFIX)) return;

  const [rawCmd, ...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (rawCmd || '').toLowerCase();
  if (commands[cmd]) await commands[cmd]({ jid, m, args });
}

// ---------- Baileys Connection ----------
async function start() {
  if (starting) return;
  starting = true;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = [2, 3000, 1015901307];
  }

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
    markOnlineOnConnect: false,
    keepAliveIntervalMs: 30_000,
  });

  sock.ev.on('creds.update', saveCreds);

  // Handle Pairing Request from cPanel File System
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // If QR is requested but we have a pairing file, request pairing code instead
      if (!sock.authState.creds.registered && fs.existsSync(PAIRING_PHONE_FILE)) {
        let phoneNumber = fs.readFileSync(PAIRING_PHONE_FILE, 'utf8').trim();
        phoneNumber = phoneNumber.replace(/\D/g, '');
        
        if (phoneNumber.length >= 10) {
          try {
            const code = await sock.requestPairingCode(phoneNumber);
            console.log(`\n========================================`);
            console.log(` YOUR WHATSAPP PAIRING CODE IS: ${code}`);
            console.log(`========================================\n`);
            updateStatusFile('pairing_code_ready', { pairingCode: code, phone: phoneNumber });
          } catch (err) {
            console.error('[bot] Failed to request pairing code:', err.message);
            updateStatusFile('pairing_error', { error: err.message });
          }
        }
      } else {
        // Fallback to QR code
        updateStatusFile('qr_ready', { qr: qr });
        qrcode.generate(qr, { small: true });
      }
    }

    if (connection === 'open') {
      starting = false;
      updateStatusFile('connected');
      
      // Clear pairing request file once connected
      if (fs.existsSync(PAIRING_PHONE_FILE)) {
        try { fs.unlinkSync(PAIRING_PHONE_FILE); } catch(e) {}
      }
      
      console.log(`[bot] Connected as ${jidNormalizedUser(sock.user?.id || '')}`);
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      console.log(`[bot] Connection closed (code=${code})${loggedOut ? ' — LOGGED OUT' : ''}`);
      sock = null;
      starting = false;
      updateStatusFile('disconnected');

      if (loggedOut) {
        console.log('[bot] Session logged out. Delete ./auth folder and restart.');
        process.exit(1);
      }

      setTimeout(() => start().catch((e) => {
        console.error('[bot] Reconnection error:', e?.message || e);
        starting = false;
      }), RECONNECT_MS);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      try {
        await handleMessage(m);
      } catch (err) {
        console.error('[bot] Message handler error:', err);
      }
    }
  });
}

// ---------- Process Handlers ----------
process.on('unhandledRejection', (err) => console.error('[bot] Unhandled Rejection:', err));
process.on('uncaughtException',  (err) => console.error('[bot] Uncaught Exception:', err));

process.on('SIGINT', async () => {
  console.log('\n[bot] Shutting down...');
  try { await sock?.end?.(); } catch {}
  process.exit(0);
});

start().catch((err) => {
  console.error('[bot] Fatal start error:', err);
  process.exit(1);
});