// telegramReporter.js
import "dotenv/config";
import axios from 'axios';

// Anda bisa menambahkan logger sederhana di sini jika mau, atau cukup console.log
const colors = { reset: "\x1b[0m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m" };
const localLogger = {
    info: (msg) => console.log(`${colors.cyan}[i] [Telegram] ${msg}${colors.reset}`),
    error: (msg) => console.log(`${colors.red}[✗] [Telegram] ${msg}${colors.reset}`),
};

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export async function sendTelegramNotification(message) {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
        localLogger.error("Variabel .env Telegram (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID) tidak diset. Notifikasi dilewati.");
        return;
    }

    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    try {
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Markdown' // Menggunakan Markdown untuk format teks
        });
        localLogger.info("Notifikasi Telegram berhasil terkirim.");
    } catch (error) {
        const errorMessage = error.response ? JSON.stringify(error.response.data) : error.message;
        localLogger.error(`Gagal mengirim notifikasi Telegram: ${errorMessage}`);
    }
}
