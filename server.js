const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// Serve downloads
app.use('/downloads', express.static(DOWNLOAD_DIR));

// Detect platform from URL
function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) return 'facebook';
  if (url.includes('instagram.com')) return 'instagram';
  return 'other';
}

// Get video info
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);

  exec(`yt-dlp --dump-json --no-playlist "${url}"`, { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      return res.status(400).json({ error: 'Could not fetch video info. Make sure the URL is valid and the video is public.' });
    }
    try {
      const info = JSON.parse(stdout);
      const formats = (info.formats || [])
        .filter(f => f.ext && (f.height || f.abr))
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext,
          height: f.height || null,
          abr: f.abr || null,
          filesize: f.filesize || f.filesize_approx || null,
          label: f.height ? `${f.height}p (${f.ext})` : `Audio ${f.abr}kbps (${f.ext})`
        }))
        .sort((a, b) => (b.height || 0) - (a.height || 0));

      // Deduplicate by label
      const seen = new Set();
      const uniqueFormats = formats.filter(f => {
        if (seen.has(f.label)) return false;
        seen.add(f.label);
        return true;
      });

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader || info.channel,
        platform,
        formats: uniqueFormats.slice(0, 10),
        webpage_url: info.webpage_url || url
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

// Download video
app.post('/api/download', (req, res) => {
  const { url, format_id, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const safeTitle = (title || 'video').replace(/[^a-zA-Z0-9_\- ]/g, '_').substring(0, 60);
  const filename = `${safeTitle}_${Date.now()}`;
  const outputTemplate = path.join(DOWNLOAD_DIR, `${filename}.%(ext)s`);

  const formatArg = format_id
    ? ['-f', format_id]
    : ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'];

  const args = [
    ...formatArg,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', outputTemplate,
    url
  ];

  let downloadedFile = null;
  const proc = spawn('yt-dlp', args);

  let progressLog = '';

  proc.stdout.on('data', (data) => {
    progressLog += data.toString();
  });

  proc.stderr.on('data', (data) => {
    progressLog += data.toString();
  });

  proc.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Download failed. The video may be private or unavailable.' });
    }

    // Find the downloaded file
    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(filename));
    if (files.length === 0) {
      return res.status(500).json({ error: 'Downloaded file not found.' });
    }

    downloadedFile = files[0];
    const fileUrl = `/downloads/${downloadedFile}`;

    res.json({
      success: true,
      filename: downloadedFile,
      url: fileUrl
    });

    // Cleanup after 10 minutes
    setTimeout(() => {
      const fp = path.join(DOWNLOAD_DIR, downloadedFile);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }, 10 * 60 * 1000);
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
