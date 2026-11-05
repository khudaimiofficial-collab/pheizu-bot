'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

// ---------- CONFIG ----------
const WEBSITE_URL = 'https://pheizuofficialstore.myvipsite.fun/admin/settings.php';
const API_SECRET = 'PHEIZU_SECRET_123'; 
const PAIRING_PHONE = '916009135951'; // Ensure this is your EXACT number with country code
const BOT_NAME = 'Pheizu Store';

const logger = pino({ level: 'warn' });
let sock = null;
let pairingCodeRequested = false; // <--- ADDED THIS LOCK

async function sendToWebsite(data) {
  try {
    await fetch(`${WEBSITE_URL}?api=bot&secret=${API_SECRET}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  } catch (e) { console.log('Website offline'); }
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Only request a pairing code ONCE
    if (qr && !sock.authState.creds.registered && !pairingCodeRequested) {
      pairingCodeRequested = true; // Lock it
      try {
        const code = await sock.requestPairingCode(PAIRING_PHONE);
        console.log(`[bot] Pairing Code: ${code}`);
        await sendToWebsite({ status: 'pairing', code: code });
      } catch (err) {
        console.log("Pairing failed, falling back to QR");
        await sendToWebsite({ status: 'qr', qr: qr });
      }
    } 
    // Fallback: If pairing code fails, still send the QR to the website
    else if (qr && !sock.authState.creds.registered) {
      await sendToWebsite({ status: 'qr', qr: qr });
    }

    if (connection === 'open') {
      console.log('[bot] Connected!');
      await sendToWebsite({ status: 'connected' });
      startPollingWebsite();
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        pairingCodeRequested = false; // Reset lock on disconnect
        startBot();
      }
    }
  });
}

function startPollingWebsite() {
  setInterval(async () => {
    try {
      const res = await fetch(`${WEBSITE_URL}?api=otp&action=get&secret=${API_SECRET}`);
      const json = await res.json();

      if (json.status === 'success' && json.data) {
        const { id, phone, otp } = json.data;
        const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: `*${BOT_NAME}*\n\nYour OTP is: *${otp}*` });
        await fetch(`${WEBSITE_URL}?api=otp&action=mark&id=${id}&secret=${API_SECRET}`);
        console.log(`[bot] Sent OTP to +${phone}`);
      }
    } catch (err) {}
  }, 5000); 
}

startBot();
