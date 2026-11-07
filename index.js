'use strict';

const makeWASocket = require('@whiskeysockets/baileys').default;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');

// ---------- CONFIGURATION ----------
const SEND_OTP_URL = process.env.SEND_OTP_URL;
const API_SECRET = process.env.API_SECRET; 
const SETTINGS_PAGE_URL = process.env.SETTINGS_PAGE_URL;
const BOT_NAME = 'Pheizu Store';

const logger = pino({ level: 'warn' });
let sock = null;
let lastPairingCode = null; 

async function callApi(action, data = {}) {
    try {
        const res = await fetch(`${SEND_OTP_URL}?action=${action}&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        return await res.json();
    } catch (e) { return { status: 'error' }; }
}

async function sendStatusToSettings(status, data = {}) {
    try {
        await fetch(`${SETTINGS_PAGE_URL}?api=bot&secret=${API_SECRET}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status, ...data })
        });
    } catch (e) {}
}

// Fetch the phone number from the website database
async function getBotPhoneNumber() {
    try {
        const res = await fetch(`${SETTINGS_PAGE_URL}?api=bot&secret=${API_SECRET}`);
        const data = await res.json();
        return data.bot_phone || null;
    } catch (e) {
        return null;
    }
}

async function startBot() {
    const hasSession = fs.existsSync('./auth/creds.json');
    
    if (hasSession) {
        await sendStatusToSettings('connecting');
    }

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

        if (qr && !sock.authState.creds.registered) {
            
            // If we don't have a pairing code yet, fetch the number and request one
            if (!lastPairingCode) {
                const botPhone = await getBotPhoneNumber();
                if (botPhone) {
                    try {
                        lastPairingCode = await sock.requestPairingCode(botPhone);
                        console.log(`[bot] Pairing Code Generated for +${botPhone}: ${lastPairingCode}`);
                    } catch (err) {
                        console.log('[bot] Failed to get pairing code:', err.message);
                    }
                } else {
                    console.log('[bot] No bot phone number set in admin settings. Skipping pairing code.');
                }
            }
            
            // Send both QR and Pairing Code to the website
            await sendStatusToSettings('qr', { 
                qr: qr, 
                pairing: lastPairingCode 
            });
        }

        if (connection === 'open') {
            lastPairingCode = null; // Reset when connected
            await sendStatusToSettings('connected');
            startPollingWebsite();
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode;
            if (code !== DisconnectReason.loggedOut) {
                lastPairingCode = null;
                startBot();
            } else {
                await sendStatusToSettings('disconnected');
            }
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const text = msg.message.conversation || msg.message.extendedMessage?.text || '';
        const jid = msg.key.remoteJid;

        if (text.startsWith('!otp ')) {
            const phone = text.split(' ')[1];
            const res = await callApi('request', { phone });
            await sock.sendMessage(jid, { text: res.status === 'success' ? `✅ OTP requested!` : `❌ ${res.message}` }, { quoted: msg });
        }

        if (text.startsWith('!verify ')) {
            const args = text.split(' ');
            const res = await callApi('verify', { phone: args[1], otp: args[2] });
            await sock.sendMessage(jid, { text: res.status === 'success' ? `✅ Verified!` : `❌ ${res.message}` }, { quoted: msg });
        }
    });
}

function startPollingWebsite() {
    setInterval(async () => {
        const res = await callApi('fetch');
        if (res.status === 'success' && res.data) {
            const { id, phone, otp } = res.data;
            const jid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;

            try {
                await sock.sendMessage(jid, { text: `*${BOT_NAME}*\n\nYour verification code is: *${otp}*\n\nValid for 10 minutes.` });
                await callApi('mark_sent', { id });
            } catch (err) {
                await callApi('mark_sent', { id });
            }
        }
    }, 5000);
}

startBot();
