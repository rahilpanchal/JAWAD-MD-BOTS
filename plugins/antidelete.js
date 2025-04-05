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
        this.lastProcessed = new Map(); // Track last processed deletions
        this.loadDatabase();
        this.cleanupInterval = setInterval(() => this.cleanExpiredMessages(), this.cacheExpiry);
    }

    /* Database Methods */
    loadDatabase() {
        try {
            if (fs.existsSync(DB_FILE)) {
                const { cache, lastProcessed } = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
                this.messageCache = new Map(cache || []);
                this.lastProcessed = new Map(lastProcessed || []);
            }
        } catch (error) {
            console.error('🚨 Database load error:', error.message);
        }
    }

    saveDatabase() {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify({
                cache: [...this.messageCache],
                lastProcessed: [...this.lastProcessed]
            }), 'utf8');
        } catch (error) {
            console.error('🚨 Database save error:', error.message);
        }
    }

    /* Message Handling */
    addMessage(key, message) {
        this.messageCache.set(key, message);
        this.saveDatabase();
    }

    markAsProcessed(key) {
        this.lastProcessed.set(key, Date.now());
        this.saveDatabase();
    }

    cleanExpiredMessages() {
        const now = Date.now();
        // Clean old messages
        for (const [key, msg] of this.messageCache.entries()) {
            if (now - msg.timestamp > this.cacheExpiry) {
                this.messageCache.delete(key);
                this.lastProcessed.delete(key);
            }
        }
        // Clean old processed entries
        for (const [key, timestamp] of this.lastProcessed.entries()) {
            if (now - timestamp > this.cacheExpiry) {
                this.lastProcessed.delete(key);
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

// Global variable to track active processing
const activeProcessing = new Set();

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
            antiDelete.lastProcessed.clear();
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
                            const stream = await downloadContentFromMessage(msg.message[`${type}Message`], type);
                            let buffer = Buffer.from([]);
                            for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
                            media = buffer;
                            mediaType = type;
                            break;
                        } catch (error) {
                            console.error(`⚠️ Failed to download ${type}:`, error.message);
                            continue;
                        }
                    }
                }

                if (content || media) {
                    antiDelete.addMessage(msg.key.id, {
                        content,
                        media,
                        type: mediaType,
                        sender: msg.key.participant || msg.key.remoteJid,
                        timestamp: Date.now(),
                        chatJid: msg.key.remoteJid
                    });
                }
            } catch (error) {
                console.error('⚠️ Message caching error:', error.message);
            }
        }
    });

    /* Deletion Handler with Event Deduplication */
    Matrix.ev.on('messages.update', async updates => {
        if (!antiDelete.enabled || !updates?.length) return;

        for (const update of updates) {
            const { key, update: updateData } = update;
            
            // Skip if not a deletion event
            if (updateData?.messageStubType !== proto.WebMessageInfo.StubType.REVOKE) continue;
            
            // Skip if we don't have this message cached
            if (!antiDelete.messageCache.has(key.id)) continue;
            
            // Skip if already being processed or recently processed
            if (activeProcessing.has(key.id) continue;
            if (antiDelete.lastProcessed.has(key.id) {
                const lastProcessTime = antiDelete.lastProcessed.get(key.id);
                if (Date.now() - lastProcessTime < 1000) continue; // Skip if processed in last second
            }

            // Mark as being processed
            activeProcessing.add(key.id);
            
            try {
                const msg = antiDelete.messageCache.get(key.id);
                const destination = config.ANTI_DELETE_PATH === "same" ? key.remoteJid : Matrix.user.id;

                // Mark as processed immediately
                antiDelete.markAsProcessed(key.id);

                // Prepare alert
                const alertMsg = [
                    `━━〔 *ANTI-DELETE ALERT ⚠️* 〕━━┈⊷`,
                    `┃◈╭─────────────·๏`,
                    `┃◈┃• *Type:* ${msg.type?.toUpperCase() || 'TEXT'}`,
                    `┃◈┃• *Sender:* @${formatJid(msg.sender)}`,
                    `┃◈┃• *Time:* ${formatTime(msg.timestamp)}`,
                    `┃◈╰─────────────·๏`
                ].join('\n');

                // Send recovery
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

                // Remove from cache after sending
                antiDelete.messageCache.delete(key.id);
                antiDelete.saveDatabase();

            } catch (error) {
                console.error('⚠️ Deletion handling error:', error.message);
                // If failed, remove from processed to allow retry
                antiDelete.lastProcessed.delete(key.id);
            } finally {
                // Always remove from active processing
                activeProcessing.delete(key.id);
            }
        }
    });
};

export default AntiDelete;
