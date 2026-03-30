const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);
app.use('/downloads', express.static(DOWNLOAD_DIR));

const COOKIES_PATH = '/etc/secrets/cookies.txt';

function detectPlatform(url) {
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.com')) return 'facebook';
  if (url.includes('instagram.com')) return 'instagram';
  if (url.includes('tiktok.com')) return 'tiktok';
  if (url.includes('twitter.com') || url.includes('x.com')) return 'twitter';
  if (url.includes('vimeo.com')) return 'vimeo';
  return 'other';
}

// ── GET VIDEO INFO ──
app.post('/api/info', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);

  // Only use cookies for YouTube
  const cookiesFlag = (platform === 'youtube' && fs.existsSync(COOKIES_PATH))
    ? `--cookies ${COOKIES_PATH}` : '';

  const extraArgs = platform === 'youtube'
    ? '--extractor-args "youtube:player_client=android,web"' : '';

  const cmd = `yt-dlp --dump-json --no-playlist ${cookiesFlag} ${extraArgs} "${url}"`;
  console.log(`[INFO] ${platform}: ${cmd}`);

  exec(cmd, { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) {
      console.error('[INFO ERROR]', stderr);
      return res.status(400).json({ error: 'Could not fetch video info. The video may be private or unavailable.' });
    }
    try {
      const info = JSON.parse(stdout.trim().split('\n')[0]);
      const formats = info.formats || [];
      const resolutions = [2160, 1440, 1080, 720, 480, 360, 240, 144];
      const smartFormats = [{ format_id: 'best', label: '⭐ Best Quality (Auto)', ext: 'mp4', filesize: null }];

      resolutions.forEach(r => {
        const vf = formats
          .filter(f => f.height === r && f.vcodec && f.vcodec !== 'none')
          .sort((a, b) => (b.filesize || 0) - (a.filesize || 0))[0];
        if (vf) smartFormats.push({
          format_id: `${r}p`, label: `${r}p`, ext: 'mp4',
          filesize: vf.filesize || vf.filesize_approx || null
        });
      });

      const audioBest = formats
        .filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
        .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];
      if (audioBest) smartFormats.push({
        format_id: 'audio', label: '🎵 Audio Only (MP3)', ext: 'mp3', filesize: null
      });

      res.json({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        uploader: info.uploader || info.channel || '',
        platform,
        formats: smartFormats,
        webpage_url: info.webpage_url || url
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse video info.' });
    }
  });
});

// ── DOWNLOAD — stream yt-dlp output directly to browser ──
app.post('/api/download', (req, res) => {
  const { url, format_id, title } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const platform = detectPlatform(url);
  const safeTitle = (title || 'video').replace(/[^a-zA-Z0-9_\- ]/g, '_').substring(0, 80);
  const ext = format_id === 'audio' ? 'mp3' : 'mp4';

  // Build format selector
  let formatArg;
  if (!format_id || format_id === 'best') {
    // best[ext=mp4] picks a SINGLE combined stream — no merging needed, very fast
    formatArg = ['-f', 'best[ext=mp4]/best'];
  } else if (format_id === 'audio') {
    formatArg = ['-f', 'bestaudio[ext=m4a]/bestaudio'];
  } else {
    const height = format_id.replace('p', '');
    formatArg = ['-f', `best[height<=${height}][ext=mp4]/best[height<=${height}]/best`];
  }

  // Only cookies for YouTube
  const cookiesArgs = (platform === 'youtube' && fs.existsSync(COOKIES_PATH))
    ? ['--cookies', COOKIES_PATH] : [];

  const extraArgs = platform === 'youtube'
    ? ['--extractor-args', 'youtube:player_client=android,web'] : [];

  // -o - streams to stdout → we pipe directly to browser (no disk, no timeout)
  const args = [
    ...formatArg,
    '--no-playlist',
    ...cookiesArgs,
    ...extraArgs,
    '-o', '-',
    url
  ];

  console.log(`[DOWNLOAD] ${platform}:`, args.join(' '));

  // Send headers immediately so browser starts saving right away
  res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}.${ext}"`);
  res.setHeader('Content-Type', ext === 'mp3' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Transfer-Encoding', 'chunked');

  const proc = spawn('yt-dlp', args);

  // Pipe yt-dlp → browser directly, bytes flow as soon as yt-dlp fetches them
  proc.stdout.pipe(res);

  proc.stderr.on('data', d => process.stderr.write(d));

  proc.on('close', code => {
    console.log(`[DOWNLOAD] exit code ${code}`);
    if (!res.writableEnded) res.end();
  });

  // Kill yt-dlp if user cancels
  req.on('close', () => proc.kill('SIGTERM'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`VidSnatch running at http://localhost:${PORT}`);
  console.log(`Cookies: ${fs.existsSync(COOKIES_PATH) ? '✅ found' : '❌ not found'}`);
});
