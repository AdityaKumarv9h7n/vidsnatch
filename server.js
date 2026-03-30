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

app.use('/downloads', express.static(DOWNLOAD_DIR));

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) return 'facebook';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  if (url.includes('vimeo.com')) return 'vimeo';
  return 'other';
}

app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  const extraArgs = platform === 'youtube'
    ? '--extractor-args "youtube:player_client=android,web"'
    : '';

  const cmd = `yt-dlp --dump-json --no-playlist ${extraArgs} "${url}"`;

  exec(cmd, { timeout: 45000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('Info error:', stderr);
      return res.status(400).json({
        error: 'Could not fetch video info. The video may be private, age-restricted, or unavailable.'
      });
    }

    try {
      const firstLine = stdout.trim().split('\n')[0];
      const info = JSON.parse(firstLine);
      const formats = (info.formats || []);

      const resolutions = [2160, 1440, 1080, 720, 480, 360, 240, 144];
      const smartFormats = [];

      smartFormats.push({
        format_id: 'best',
        label: '⭐ Best Quality (Auto)',
        ext: 'mp4',
        filesize: null,
        isAuto: true
      });

      resolutions.forEach(res => {
        const videoFmt = formats
          .filter(f => f.height === res && f.vcodec && f.vcodec !== 'none')
          .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];

        if (videoFmt) {
          const size = videoFmt.filesize || videoFmt.filesize_approx;
          smartFormats.push({
            format_id: `${res}p`,
            label: `${res}p`,
            ext: 'mp4',
            filesize: size,
            height: res
          });
        }
      });

      const audioBest = formats
        .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

      if (audioBest) {
        smartFormats.push({
          format_id: 'audio',
          label: '🎵 Audio Only (MP3)',
          ext: 'mp3',
          filesize: audioBest.filesize || null,
          isAudio: true
        });
      }

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader || info.channel || info.uploader_id,
        platform,
        formats: smartFormats,
        webpage_url: info.webpage_url || url
      });
    } catch (e) {
      console.error('Parse error:', e);
      res.status(500).json({ error: 'Failed to parse video info' });
    }
  });
});

app.post('/api/download', (req, res) => {
  const { url, format_id, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  const safeTitle = (title || 'video').replace(/[^a-zA-Z0-9_\- ]/g, '_').substring(0, 60);
  const filename = `${safeTitle}_${Date.now()}`;
  const outputTemplate = path.join(DOWNLOAD_DIR, `${filename}.%(ext)s`);

  let formatArg;

  if (!format_id || format_id === 'best') {
    formatArg = ['-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best'];
  } else if (format_id === 'audio') {
    formatArg = ['-f', 'bestaudio', '-x', '--audio-format', 'mp3'];
  } else {
    const height = format_id.replace('p', '');
    formatArg = [
      '-f',
      `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]/best`
    ];
  }

  const extraArgs = platform === 'youtube'
    ? ['--extractor-args', 'youtube:player_client=android,web']
    : [];

  const args = [
    ...formatArg,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    ...extraArgs,
    '-o', outputTemplate,
    url
  ];

  console.log('Running yt-dlp:', args.join(' '));
  const proc = spawn('yt-dlp', args);
  let log = '';

  proc.stdout.on('data', d => { log += d.toString(); process.stdout.write(d); });
  proc.stderr.on('data', d => { log += d.toString(); process.stderr.write(d); });

  proc.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: 'Download failed. The video may be private or unavailable.' });
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(filename));
    if (files.length === 0) {
      return res.status(500).json({ error: 'Downloaded file not found on server.' });
    }

    const downloadedFile = files[0];
    res.json({
      success: true,
      filename: downloadedFile,
      url: `/downloads/${encodeURIComponent(downloadedFile)}`
    });

    setTimeout(() => {
      const fp = path.join(DOWNLOAD_DIR, downloadedFile);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }, 15 * 60 * 1000);
  });
});

const COOKIES = fs.existsSync('/etc/secrets/cookies.txt')
  ? '--cookies /etc/secrets/cookies.txt'
  : '';

const cmd = `yt-dlp --dump-json --no-playlist ${COOKIES} ${extraArgs} "${url}"`;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VidSnatch running at http://localhost:${PORT}`);
});
