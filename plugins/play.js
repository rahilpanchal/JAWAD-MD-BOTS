import { writeFile } from 'fs/promises';
import config from '../config.cjs';
import yts from 'yt-search';
import axios from 'axios';

const playCommand = async (m, sock) => {
  const prefix = config.PREFIX;
  const cmd = m.body.startsWith(prefix) ? m.body.slice(prefix.length).split(' ')[0].toLowerCase() : '';
  const args = m.body.slice(prefix.length + cmd.length).trim();

  const validCommands = ['play', 'mp3', 'ytmp3', 'play2'];

  if (validCommands.includes(cmd)) {
    try {
      if (!args.length) {
        await sock.sendMessage(m.from, { 
          text: 'Please provide a song name. Example: .play Moye Moye' 
        }, { quoted: m });
        return;
      }

      // Add processing reaction
      await sock.sendMessage(m.from, { 
        react: { 
          text: '⚡', 
          key: m.key 
        } 
      });

      // Search for the song on YouTube
      const query = args.join(" ");
      const searchResults = await yts(query);
      
      if (!searchResults.videos.length) {
        await sock.sendMessage(m.from, { 
          react: { 
            text: '❌', 
            key: m.key 
          } 
        });
        await sock.sendMessage(m.from, { 
          text: '❌ No results found.' 
        }, { quoted: m });
        return;
      }

      const videoUrl = searchResults.videos[0].url;
      let mp3Url;

      // Use different API endpoints for play and play2 commands
      if (cmd === 'play2') {
        const apiUrl = `https://apis.davidcyriltech.my.id/youtube/mp3?url=${videoUrl}`;
        const response = await axios.get(apiUrl);
        if (!response.data.success || !response.data.result.downloadUrl) {
          throw new Error('Failed to fetch MP3 from play2 API');
        }
        mp3Url = response.data.result.downloadUrl;
      } else {
        const apiUrl = `https://apis.davidcyriltech.my.id/download/ytmp3?url=${videoUrl}`;
        const response = await axios.get(apiUrl);
        if (!response.data.success || !response.data.result.download_url) {
          throw new Error('Failed to fetch MP3 from play API');
        }
        mp3Url = response.data.result.download_url;
      }

      // Send the MP3 as an audio file
      await sock.sendMessage(m.from, {
        audio: { url: mp3Url },
        mimetype: 'audio/mpeg',
        ptt: false
      }, { quoted: m });

      // Add success reaction
      await sock.sendMessage(m.from, { 
        react: { 
          text: '✅', 
          key: m.key 
        } 
      });

    } catch (error) {
      console.error("Error in play command:", error);
      
      // Add failure reaction
      await sock.sendMessage(m.from, { 
        react: { 
          text: '❌', 
          key: m.key 
        } 
      });

      // Send error message
      const errorMessage = `*❌ Error in ${cmd} command*\n\n` +
        `*Error:* ${error.message}\n` +
        `*Timestamp:* ${new Date().toLocaleString()}`;
      
      await sock.sendMessage(m.from, { 
        text: errorMessage 
      }, { quoted: m });
    }
  }
};

export default playCommand;
