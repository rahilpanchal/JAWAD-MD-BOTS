import pkg from '@whiskeysockets/baileys';
const { proto, downloadContentFromMessage } = pkg;
import config from '../config.cjs';
import fs from 'fs';
import path from 'path';

// Database Configuration
const DB_FILE = path.join(process.cwd(), 'database.json');

class AntiDeleteSystem {
    constructor() {
        this.enabled = config.ANTI_DELETE || false;
        this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
        this.messageCache = new Map();
        this.processedDeletions = new Set(); // Track processed deletions
        this.loadDatabase();
        this.cleanupInterval = setInterval(() => this.cleanExpiredMessages(), this.cacheExpiry);
    }

    /* Database Methods */
    loadDatabase() {
        try {
            if (fs.existsSync(DB_FILE)) {
                const { cache, processed } = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
                this.messageCache = new Map(cache || []);
                this.processedDeletions = new Set(processed || []);
            }
        } catch (error) {
            console.error('🚨 Database load error:', error.message);
        }
    }

    saveDatabase() {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify({
                cache: [...this.messageCache],
                processed: [...this.processedDeletions]
            }), 'utf8');
        } catch (error) {
            console.error('🚨 Database save error:', error.message);
        }
    }

    /* Media Download with Retry */
    async downloadMediaWithRetry(mediaMsg, type, retries = 3) {
        for (let i = 0; i < retries; i++) {
            try {
                const stream = await downloadContentFromMessage(mediaMsg, type);
                let buffer = Buffer.from([]);
                for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                return buffer;
            } catch (error) {
                if (i === retries - 1) throw error;
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
            }
        }
    }

    /* Cleanup */
    cleanExpiredMessages() {
        const now = Date.now();
        for (const [key, msg] of this.messageCache.entries()) {
            if (now - msg.timestamp > this.cacheExpiry) {
                this.messageCache.delete(key);
                this.processedDeletions.delete(key);
            }
        }
        this.saveDatabase();
    }

    destroy() {
        clearInterval(this.cleanupInterval);
        this.saveDatabase();
    }
}

const antiDelete = new AntiDeleteSystem();

const AntiDelete = async (m, Matrix) => {
    // Authorization
    const botNumber = await Matrix.decodeJid(Matrix.user.id);
    const isCreator = [botNumber, config.OWNER_NUMBER + '@s.whatsapp.net'].includes(m.sender);
    const prefix = config.PREFIX;
    const cmd = m.body.startsWith(prefix) ? m.body.slice(prefix.length).split(' ')[0].toLowerCase() : '';
    const text = m.body.slice(prefix.length + cmd.length).trim();

    // Formatting
    const formatJid = (jid) => jid?.replace(/@.+/, '') || 'Unknown';
    const formatTime = (timestamp) => new Date(timestamp).toLocaleString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        day: '2-digit',
        month: 'short'
    });

    // Command Handler
    if (cmd === 'antidelete') {
        if (!isCreator) return m.reply("*📛 THIS IS AN OWNER COMMAND*");
        
        const mode = config.ANTI_DELETE_PATH === "same" ? "🔄 Same Chat" : "📨 Bot Inbox";

        if (text === 'on') {
            antiDelete.enabled = true;
            await m.reply(`━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Status:* 🟢 ENABLED\n┃◈┃• *Mode:* ${mode}\n┃◈╰─────────────·๏`);
        } 
        else if (text === 'off') {
            antiDelete.enabled = false;
            antiDelete.messageCache.clear();
            antiDelete.processedDeletions.clear();
            await m.reply(`━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Status:* 🔴 DISABLED\n┃◈╰─────────────·๏`);
        }
        else {
            await m.reply(`━━〔 *ANTI-DELETE* 〕━━┈⊷\n┃◈╭─────────────·๏\n┃◈┃• *Usage:*\n┃◈┃• ${prefix}antidelete on\n┃◈┃• ${prefix}antidelete off\n┃◈┃• *Current Mode:* ${mode}\n┃◈╰─────────────·๏`);
        }
        await m.React(antiDelete.enabled ? '✅' : '❌');
        return;
    }

    /* Message Caching */
    Matrix.ev.on('messages.upsert', async ({ messages }) => {
        if (!antiDelete.enabled || !messages?.length) return;

        for (const msg of messages) {
            if (msg.key.fromMe || !msg.message || msg.key.remoteJid === 'status@broadcast') continue;

            try {
                const content = msg.message.conversation || 
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    msg.message.documentMessage?.caption;

                let media, mediaType;
                for (const type of ['image', 'video', 'audio', 'document', 'sticker']) {
                    if (msg.message[`${type}Message`]) {
                        try {
                            media = await antiDelete.downloadMediaWithRetry(
                                msg.message[`${type}Message`],
                                type
                            );
                            mediaType = type;
                            break;
                        } catch (error) {
                            console.error(`⚠️ Failed to download ${type}:`, error.message);
                            continue;
                        }
                    }
                }

                if (content || media) {
                    antiDelete.messageCache.set(msg.key.id, {
                        content,
                        media,
                        type: mediaType,
                        sender: msg.key.participant || msg.key.remoteJid,
                        timestamp: Date.now(),
                        chatJid: msg.key.remoteJid
                    });
                    antiDelete.saveDatabase();
                }
            } catch (error) {
                console.error('⚠️ Message caching error:', error.message);
            }
        }
    });

    /* Deletion Handler with Anti-Spam */
    Matrix.ev.on('messages.update', async updates => {
        if (!antiDelete.enabled || !updates?.length) return;

        for (const update of updates) {
            try {
                const { key, update: updateData } = update;
                
                // Skip if not a deletion event, not in cache, or already processed
                if (updateData?.messageStubType !== proto.WebMessageInfo.StubType.REVOKE || 
                    !antiDelete.messageCache.has(key.id) ||
                    antiDelete.processedDeletions.has(key.id)) {
                    continue;
                }

                const msg = antiDelete.messageCache.get(key.id);
                const destination = config.ANTI_DELETE_PATH === "same" ? key.remoteJid : Matrix.user.id;

                // Prepare alert (only once)
                const alertMsg = [
                    `━━〔 *ANTI-DELETE ALERT ⚠️* 〕━━┈⊷`,
                    `┃◈╭─────────────·๏`,
                    `┃◈┃• *Type:* ${msg.type?.toUpperCase() || 'TEXT'}`,
                    `┃◈┃• *Sender:* @${formatJid(msg.sender)}`,
                    `┃◈┃• *Time:* ${formatTime(msg.timestamp)}`,
                    `┃◈╰─────────────·๏`
                ].join('\n');

                // Send recovery (only once)
                if (msg.media) {
                    await Matrix.sendMessage(destination, {
                        [msg.type]: msg.media,
                        ...(msg.type !== 'sticker' && { caption: alertMsg }),
                        mentions: [msg.sender]
                    });
                    if (msg.type === 'sticker') {
                        await Matrix.sendMessage(destination, { text: alertMsg });
                    }
                } else {
                    await Matrix.sendMessage(destination, {
                        text: `${alertMsg}\n┃◈• *Content:*\n${msg.content}`,
                        mentions: [msg.sender]
                    });
                }

                // Mark as processed immediately
                antiDelete.processedDeletions.add(key.id);
                antiDelete.messageCache.delete(key.id);
                antiDelete.saveDatabase();

            } catch (error) {
                console.error('⚠️ Deletion handling error:', error.message);
            }
        }
    });
};

export default AntiDelete;
