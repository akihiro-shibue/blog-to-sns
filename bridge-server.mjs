/**
 * blog-to-sns bridge server
 * Port: 3004
 * Endpoints:
 *   GET  /health
 *   POST /publish-facebook  { text, imageBase64?, imageMime?, pageId, accessToken }  → 下書き保存
 *   POST /publish-note      { title, content, credentials:{email,password} }          → 下書き保存
 *
 * ※ X への投稿は x.com/intent/tweet でブラウザから行う（API不使用）
 */

import http from 'http';
import https from 'https';
import crypto from 'crypto';
import { chromium } from 'playwright';
import { marked } from 'marked';

const PORT = 3004;

// ===================================================================
// UTILS
// ===================================================================
function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function httpsRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

// ===================================================================
// X (TWITTER) — OAuth 1.0a
// ===================================================================
function oauthSign(method, url, params, consumerSecret, tokenSecret) {
  const encode = s => encodeURIComponent(String(s));
  const sorted = Object.keys(params).sort()
    .map(k => `${encode(k)}=${encode(params[k])}`).join('&');
  const base = `${method}&${encode(url)}&${encode(sorted)}`;
  const key = `${encode(consumerSecret)}&${encode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}

function buildAuthHeader(method, url, extraParams, creds) {
  const oauthParams = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const allParams = { ...oauthParams, ...extraParams };
  oauthParams.oauth_signature = oauthSign(method, url, allParams, creds.apiSecret, creds.accessTokenSecret);

  const header = Object.keys(oauthParams).sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(oauthParams[k])}"`)
    .join(', ');
  return `OAuth ${header}`;
}

async function uploadMediaToX(imageBase64, imageMime, creds) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
  const mediaData = imageBase64;
  const bodyStr = `media_data=${encodeURIComponent(mediaData)}`;

  const auth = buildAuthHeader('POST', url, {}, creds);
  const result = await httpsRequest({
    method: 'POST',
    hostname: 'upload.twitter.com',
    path: '/1.1/media/upload.json',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, bodyStr);

  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`メディアアップロード失敗 ${result.status}: ${result.body}`);
  }
  const data = JSON.parse(result.body);
  return data.media_id_string;
}

async function postTweetV2(text, mediaId, creds) {
  const url = 'https://api.twitter.com/2/tweets';
  const payload = { text };
  if (mediaId) payload.media = { media_ids: [mediaId] };
  const bodyStr = JSON.stringify(payload);
  const auth = buildAuthHeader('POST', url, {}, creds);

  const result = await httpsRequest({
    method: 'POST',
    hostname: 'api.twitter.com',
    path: '/2/tweets',
    headers: {
      'Authorization': auth,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
    },
  }, bodyStr);

  if (result.status !== 201) {
    throw new Error(`ツイート投稿失敗 ${result.status}: ${result.body}`);
  }
  return JSON.parse(result.body);
}

async function publishToX({ text, imageBase64, imageMime, credentials }) {
  let mediaId = null;
  if (imageBase64) {
    console.log('X: メディアアップロード中...');
    mediaId = await uploadMediaToX(imageBase64, imageMime || 'image/jpeg', credentials);
    console.log('X: media_id =', mediaId);
  }
  console.log('X: ツイート投稿中...');
  const result = await postTweetV2(text, mediaId, credentials);
  const tweetId = result.data?.id;
  return { url: `https://x.com/i/web/status/${tweetId}` };
}

// ===================================================================
// FACEBOOK — Graph API
// ===================================================================
async function publishToFacebook({ text, imageBase64, imageMime, pageId, accessToken }) {
  if (imageBase64) {
    // Upload photo with caption
    const boundary = '----FormBoundary' + crypto.randomBytes(8).toString('hex');
    const imgBuffer = Buffer.from(imageBase64, 'base64');
    const mime = imageMime || 'image/jpeg';
    const ext = mime.split('/')[1] || 'jpg';

    const bodyParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="source"; filename="photo.${ext}"\r\nContent-Type: ${mime}\r\n\r\n`,
      imgBuffer,
      Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${text}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="access_token"\r\n\r\n${accessToken}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="published"\r\n\r\nfalse\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ];
    const body = Buffer.concat(bodyParts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));

    const result = await httpsRequest({
      method: 'POST',
      hostname: 'graph.facebook.com',
      path: `/v19.0/${pageId}/photos`,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
    }, body);

    if (result.status !== 200) {
      throw new Error(`Facebook写真投稿失敗 ${result.status}: ${result.body}`);
    }
    const data = JSON.parse(result.body);
    return { postId: data.post_id || data.id };
  } else {
    // Text only
    const bodyStr = new URLSearchParams({ message: text, access_token: accessToken, published: 'false' }).toString();
    const result = await httpsRequest({
      method: 'POST',
      hostname: 'graph.facebook.com',
      path: `/v19.0/${pageId}/feed`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, bodyStr);

    if (result.status !== 200) {
      throw new Error(`Facebook投稿失敗 ${result.status}: ${result.body}`);
    }
    return JSON.parse(result.body);
  }
}

// ===================================================================
// NOTE — Playwright
// ===================================================================
async function publishToNote({ title, content, eyecatchBase64, eyecatchMime, credentials }) {
  const { email, password } = credentials;
  if (!email || !password) throw new Error('noteのメール・パスワードが未設定です');

  const htmlContent = await marked.parse(content);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    console.log('note: ログイン中...');
    await page.goto('https://note.com/login');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('#email', { state: 'visible', timeout: 30000 });
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.waitForTimeout(500);
    const loginBtn = page.locator("button[data-type='primary']").first();
    await loginBtn.waitFor({ state: 'visible', timeout: 10000 });
    await loginBtn.click();
    await page.waitForURL('**/home**', { timeout: 15000 }).catch(() => {});
    console.log('note: ログイン成功');

    await page.goto('https://note.com/notes/new');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // タイトル入力
    const titleSel = '.o-page-editor__title textarea, [placeholder*="タイトル"], h1.editor-title';
    await page.waitForSelector(titleSel, { timeout: 15000 });
    await page.click(titleSel);
    await page.keyboard.type(title);

    // 本文入力
    const bodySel = '.ProseMirror, [contenteditable="true"].editor-body, .note-editor__body';
    await page.waitForSelector(bodySel, { timeout: 10000 });
    await page.click(bodySel);
    await page.waitForTimeout(500);

    // マークダウン → クリップボード経由で貼り付け
    for (const line of content.split('\n')) {
      if (line.startsWith('## ')) {
        await page.keyboard.type(line.replace(/^## /, ''));
        await page.keyboard.press('Enter');
      } else if (line.startsWith('# ')) {
        await page.keyboard.type(line.replace(/^# /, ''));
        await page.keyboard.press('Enter');
      } else {
        await page.keyboard.type(line);
        await page.keyboard.press('Enter');
      }
    }

    // アイキャッチ画像
    if (eyecatchBase64) {
      try {
        const imgBuffer = Buffer.from(eyecatchBase64, 'base64');
        const mime = eyecatchMime || 'image/jpeg';
        const ext = mime.split('/')[1] || 'jpg';
        const tmpPath = `/tmp/note_eyecatch_${Date.now()}.${ext}`;
        require('fs').writeFileSync(tmpPath, imgBuffer);

        const uploadBtn = page.locator('[data-testid="eyecatch-upload"], button:has-text("アイキャッチ")').first();
        if (await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
          const [fileChooser] = await Promise.all([
            page.waitForFileChooser(),
            uploadBtn.click(),
          ]);
          await fileChooser.setFiles(tmpPath);
          await page.waitForTimeout(2000);
        }
      } catch (imgErr) {
        console.warn('アイキャッチアップロードをスキップ:', imgErr.message);
      }
    }

    // 下書き保存のみ（公開しない）
    const draftBtn = page.locator('button:has-text("下書き保存"), [data-testid="draft-save"]').first();
    await draftBtn.waitFor({ state: 'visible', timeout: 10000 });
    await draftBtn.click();
    await page.waitForTimeout(2000);
    const url = page.url();
    console.log('note: 下書き保存完了', url);
    return { url };
  } finally {
    await browser.close();
  }
}

// ===================================================================
// HTTP SERVER
// ===================================================================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, { ok: true, port: PORT });
    return;
  }

  if (req.method === 'POST' && req.url === '/publish-x') {
    try {
      const body = await jsonBody(req);
      console.log('[X] 投稿開始...');
      const result = await publishToX(body);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error('[X] エラー:', err.message);
      sendJSON(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/publish-facebook') {
    try {
      const body = await jsonBody(req);
      console.log('[Facebook] 投稿開始...');
      const result = await publishToFacebook(body);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error('[Facebook] エラー:', err.message);
      sendJSON(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && req.url === '/publish-note') {
    try {
      const body = await jsonBody(req);
      console.log('[note] 投稿開始...');
      const result = await publishToNote(body);
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error('[note] エラー:', err.message);
      sendJSON(res, 500, { ok: false, error: err.message });
    }
    return;
  }

  sendJSON(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`blog-to-sns bridge-server: http://localhost:${PORT}`);
  console.log('エンドポイント: /publish-x  /publish-facebook  /publish-note');
});
