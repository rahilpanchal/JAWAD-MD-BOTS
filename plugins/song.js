import axios from "axios";
import yts from "yt-search";
import config from '../config.cjs';

const song = async (m, gss) => {
  const prefix = config.PREFIX;
  const cmd = m.body.startsWith(prefix) ? m.body.slice(prefix.length).split(" ")[0].toLowerCase() : "";
  const args = m.body.slice(prefix.length + cmd.length).trim();

  const validCommands = ['song', 'video'];
  if (validCommands.includes(cmd)) {
    if (!args) return m.reply("Please provide a song name\nExample: .song Moye Moye");

    try {
      m.reply("🔍 Searching for your song...");
      const searchResults = await yts(args);
      if (!searchResults.videos.length) return m.reply("❌ No results found");

      const video = searchResults.videos[0];
      const apiUrl = `https://api.davidcyriltech.my.id/download/ytmp4?url=${video.url}`;
      const { data } = await axios.get(apiUrl);

      if (!data.success) return m.reply("❌ Failed to download video");

      await gss.sendMessage(
        m.from,
        { 
          video: { url: data.result.download_url },
          caption: `*${data.result.title}*\n\n*Powered By JawadTechX 💜*`,
          thumbnail: data.result.thumbnail
        },
        { quoted: m }
      );

    } catch (error) {
      console.error(error);
      m.reply("❌ An error occurred");
    }
  }
};

export default song;
