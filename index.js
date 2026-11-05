'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');

// ---------- CONFIGURATION ----------
const SEND_OTP_URL = 'https://pheizuofficialstore.myvipsite.fun/send_otp.php';
const API_SECRET = 'PHEIZU_SECRET_123'; 
const BOT_NAME = 'Pheizu Store';
const SETTINGS_PAGE_URL = 'https://pheizuofficialstore.myvipsite.fun/admin/settings.php';

const logger = pino({ level: 'warn' });
let sock = null;
let qrSent = false; // <--- LOCK: Prevents sending QR repeatedly

// Helper to call the PHP OTP API
async function callApi(action, data = {}) {
    try {
        const res = await fetch(`${SEND_OTP_URL}?action=${action}&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await res.json();
    } catch (e) {
        console.log('API Error:', e.message);
        return { status: 'error' };
    }
}

// Helper to send QR to the settings page (Only called once)
async function sendQrToSettings(qr) {
    try {
        await fetch(`${SETTINGS_PAGE_URL}?api=bot&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'qr', qr: qr })
        });
        console.log('[bot] QR Code sent to settings.php');
    } catch (e) {
        console.log('Could not send QR to settings page (network error).');
    }
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

    // --- CONNECTION UPDATE ---
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Only send the QR code ONCE to stop spamming the website
        if (qr && !sock.authState.creds.registered && !qrSent) {
            qrSent = true; // Lock it
            await sendQrToSettings(qr);
        }

        if (connection === 'open') {
            console.log('[bot] Connected to WhatsApp successfully!');
            qrSent = false; // Reset lock in case of future disconnects
            
            try {
                await fetch(`${SETTINGS_PAGE_URL}?api=bot&secret=${API_SECRET}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: 'connected' })
                });
            } catch (e) {}
            
            // Start checking the website for pending OTPs
            startPollingWebsite();
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            
            console.log(`[bot] Connection closed (code=${code})${loggedOut ? ' - LOGGED OUT' : ''}`);
            
            if (!loggedOut) {
                console.log('[bot] Reconnecting...');
                qrSent = false; // Reset lock to allow new QR if needed
                startBot();
            } else {
                console.log('[bot] You need to scan a new QR code.');
            }
        }
    });

    // --- INCOMING WHATSAPP MESSAGES (!otp, !verify) ---
    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        const jid = msg.key.remoteJid;

        // Command: !otp 9876543210
        if (text.startsWith('!otp ')) {
            const phone = text.split(' ')[1];
            const res = await callApi('request', { phone });
            await sock.sendMessage(jid, { 
                text: res.status === 'success' 
                    ? `✅ OTP requested! It will arrive in a moment.` 
                    : `❌ ${res.message}` 
            }, { quoted: msg });
        }

        // Command: !verify 9876543210 123456
        if (text.startsWith('!verify ')) {
            const args = text.split(' ');
            const phone = args[1];
            const otp = args[2];
            const res = await callApi('verify', { phone, otp });
            await sock.sendMessage(jid, { 
                text: res.status === 'success' 
                    ? `✅ Phone Verified Successfully!` 
                    : `❌ ${res.message}` 
            }, { quoted: msg });
        }
    });
}

// --- BACKGROUND LOOP: Checks if your website requested an OTP ---
function startPollingWebsite() {
    setInterval(async () => {
        const res = await callApi('fetch');
        
        if (res.status === 'success' && res.data) {
            const { id, phone, otp } = res.data;
            const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

            console.log(`[bot] Found pending OTP for +${phone}. Sending...`);

            try {
                await sock.sendMessage(jid, { 
                    text: `*${BOT_NAME}*\n\nYour verification code is: *${otp}*\n\nValid for 10 minutes. Do not share this code.` 
                });
                
                await callApi('mark_sent', { id });
                console.log(`[bot] Successfully sent OTP to +${phone}`);

            } catch (err) {
                console.log(`[bot] Failed to send to +${phone}:`, err.message);
                await callApi('mark_sent', { id }); // Mark sent to prevent infinite loop
            }
        }
    }, 5000);
}

// Start the bot
startBot();
