import { jsonResponse, handleOptions } from './_utils.js';

function decodeJsString(str) {
  str = str.replace(/\\u([\dA-Fa-f]{4})/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  str = str.replace(/\\u\{([\dA-Fa-f]+)\}/g, (_, h) => String.fromCodePoint(parseInt(h, 16)));
  str = str.replace(/\\(["\\\/nrt])/g, (_, c) => ({'"':'"', '\\':'\\', '/':'/', 'n':'\n', 'r':'\r', 't':'\t'})[c]);
  return str;
}

function decodeHtmlEntities(str) {
  return str.replace(/&#x([\dA-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&apos;/g, "'");
}

const FVIDGO_PUB_KEY = 'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCAdf/EyIbLBxjGqmh7qLU6/CPCzru+75+82OSPZ+nf4BFvg88drpZ6KigNW0J8TNgxe6Yms1irCZNVDyu+RXsl4y/7c2KOHc4OGTzHB5fUMiMasFUvcEs2P70e6yA/sKHZfBLG1XPhlb84Ibs3nhD3W5e2SuC+4EuVkaqzN08LQIDAQAB';

function bytesToBigInt(bytes) {
  let r = 0n;
  for (const b of bytes) r = (r << 8n) + BigInt(b);
  return r;
}

function bigIntToBytes(n, len) {
  const b = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { b[i] = Number(n & 0xffn); n >>= 8n; }
  return b;
}

function modPow(base, exp, mod) {
  let r = 1n;
  base %= mod;
  while (exp > 0n) { if (exp & 1n) r = (r * base) % mod; exp >>= 1n; base = (base * base) % mod; }
  return r;
}

function parseRSAPublicKey(b64) {
  const der = atob(b64);
  let off = 0;
  function readTag() { return der.charCodeAt(off++); }
  function readLen() {
    let l = der.charCodeAt(off++);
    if (l & 0x80) { const n = l & 0x7f; l = 0; for (let i = 0; i < n; i++) l = (l << 8) | der.charCodeAt(off++); }
    return l;
  }
  readTag(); readLen(); readTag(); readLen();
  readTag(); const oidLen = readLen(); off += oidLen;
  readTag(); readLen();
  readTag(); readLen(); off++;
  readTag(); readLen();
  readTag(); const nLen = readLen();
  const nBytes = new Uint8Array(der.slice(off, off + nLen).split('').map(c => c.charCodeAt(0)));
  const hasLeadingZero = nBytes[0] === 0;
  const keyLen = hasLeadingZero ? nLen - 1 : nLen;
  const n = bytesToBigInt(hasLeadingZero ? nBytes.slice(1) : nBytes);
  off += nLen;
  readTag(); const eLen = readLen();
  const e = bytesToBigInt(new Uint8Array(der.slice(off, off + eLen).split('').map(c => c.charCodeAt(0))));
  return { n, e, k: keyLen };
}

function rsaEncrypt(msg, pubB64) {
  const { n, e, k } = parseRSAPublicKey(pubB64);
  const mb = new TextEncoder().encode(msg);
  const padLen = k - mb.length - 3;
  if (padLen < 8) throw new Error('msg too long');
  const p = new Uint8Array(k);
  p[0] = 0x00; p[1] = 0x02;
  for (let i = 2; i < 2 + padLen; i++) { let b; do { b = Math.floor(Math.random() * 256); } while (b === 0); p[i] = b; }
  p[2 + padLen] = 0x00; p.set(mb, 2 + padLen + 1);
  return btoa(String.fromCharCode(...bigIntToBytes(modPow(bytesToBigInt(p), e, n), k)));
}

function decodeSnapApp(args) {
  let [h, u, n, t, e, r] = args;
  const tNum = Number(t), eNum = Number(e);
  function decode(d, e2, f) {
    const g = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/'.split('');
    const hArr = g.slice(0, e2), iArr = g.slice(0, f);
    let j = d.split('').reverse().reduce((a, b, c) => {
      const idx = hArr.indexOf(b);
      return idx !== -1 ? a + idx * Math.pow(e2, c) : a;
    }, 0);
    let k = '';
    while (j > 0) { k = iArr[j % f] + k; j = Math.floor(j / f); }
    return k || '0';
  }
  let result = '';
  for (let i = 0, len = h.length; i < len;) {
    let s = '';
    while (i < len && h[i] !== n[eNum]) { s += h[i]; i++; }
    i++;
    for (let j = 0; j < n.length; j++) s = s.replace(new RegExp(n[j], 'g'), j.toString());
    result += String.fromCharCode(Number(decode(s, eNum, 10)) - tNum);
  }
  return result;
}

function getEncodedSnapApp(data) {
  const m = data.split('decodeURIComponent(escape(r))}(')[1];
  if (!m) return null;
  return m.split('))')[0].split(',').map(v => v.replace(/"/g, '').trim());
}

function decryptSnapSave(data) {
  const encoded = getEncodedSnapApp(data);
  if (!encoded) return null;
  const decoded = decodeSnapApp(encoded);
  const errMsg = decoded.match(/document\.querySelector\("#alert"\)\.innerHTML = "([^"]+)"/);
  if (errMsg) throw new Error(errMsg[1]);
  const m = decoded.match(/getElementById\("download-section"\)\.innerHTML = "([\s\S]*?)";\s*document\.getElementById\("inputData"\)\.remove\(\)/);
  if (!m) return null;
  return m[1].replace(/\\(\\)?/g, '');
}

function extractMedia(html) {
  const allLinks = [...html.matchAll(/<a[^>]*href="([^"]+)"[^>]*>/g)];
  const url = allLinks.find(l => l[1].startsWith('http') && !l[1].includes('d.rapidcdn.app/thumb'))?.[1] || '';
  const thumbMatch = html.match(/<img[^>]*src="([^"]+)"[^>]*>/);
  const descMatch = html.match(/<span[^>]*class="[^"]*video-des[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  return {
    url,
    thumbnail: thumbMatch?.[1] || '',
    description: decodeHtmlEntities(descMatch?.[1]?.trim() || '')
  };
}

async function snapsaveFetch(url, retries = 2) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const form = new URLSearchParams();
    form.append('url', url);
    const resp = await fetch('https://snapsave.app/action.php?lang=en', {
      method: 'POST',
      headers: {
        'accept': '*/*',
        'content-type': 'application/x-www-form-urlencoded',
        'origin': 'https://snapsave.app',
        'referer': 'https://snapsave.app/',
        'user-agent': UA,
      },
      body: form.toString(),
    });
    const html = await resp.text();
    if (html.includes('Unable to connect') && attempt < retries) {
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    const decoded = decryptSnapSave(html);
    if (!decoded) { if (attempt < retries) { await new Promise(r => setTimeout(r, 500)); continue; } throw new Error('Failed to decode snapsave response'); }
    const r = extractMedia(decoded);
    if (!r.url) { if (attempt < retries) { await new Promise(r => setTimeout(r, 500)); continue; } throw new Error('No media found'); }
    return { result: r.url, title: r.description, preview: r.thumbnail };
  }
}

async function tikwmFetch(url) {
  const resp = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const data = await resp.json();
  if (!data?.data?.play) throw new Error(data.msg || 'TikTok download failed');
  return {
    result: data.data.play,
    title: data.data.title || '',
    author: data.data.author?.nickname || '',
    preview: data.data.cover || ''
  };
}

async function abBackendFetch(endpoint, url) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  try {
    const resp = await fetch(`https://backend1.tioo.eu.org/${endpoint}?url=${encodeURIComponent(url)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: ac.signal
    });
    return await resp.json();
  } finally {
    clearTimeout(to);
  }
}

async function abYoutube(url) {
  const data = await abBackendFetch('youtube', url);
  const mp4 = Array.isArray(data.mp4) ? data.mp4[0]?.url : data.mp4;
  if (!mp4) throw new Error('No YouTube URL from backend');
  return {
    result: mp4,
    title: data.title || '',
    preview: data.thumbnail || ''
  };
}

async function abTikTok(url) {
  const data = await abBackendFetch('tiktok', url);
  if (!data?.data) throw new Error('No TikTok data from backend');
  if (data.data.images?.length) {
    return {
      result: data.data.images[0],
      title: data.data.title || '',
      preview: data.data.cover || '',
      media: data.data.images,
      type: 'image'
    };
  }
  if (!data.data.play) throw new Error('No video URL from backend');
  return {
    result: data.data.play,
    title: data.data.title || '',
    preview: data.data.cover || ''
  };
}

async function abInstagram(url) {
  const data = await abBackendFetch('igdl', url);
  if (!data?.[0]?.url) throw new Error('No Instagram URL from backend');
  const allUrls = [...new Set(data.map(i => i.url).filter(Boolean))];
  const isVideo = data[0].url.match(/\.(mp4|webm|mkv|avi|mov)(\?|$)/i) || data[0]?.type === 'video' || url.includes('/reel/');
  if (isVideo) return { result: data[0].url, title: '', preview: data[0]?.thumbnail || '' };
  return { result: data[0].url, title: '', preview: data[0]?.thumbnail || '', media: allUrls, type: 'image' };
}

async function ytScrapeFallback(url) {
  const id = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([a-zA-Z0-9_-]{11})/)?.[1];
  if (!id) throw new Error('Could not extract YouTube ID');
  let title = '', preview = '';
  const resp = await fetch(`https://www.youtube.com/watch?v=${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'accept-language': 'en-US,en;q=0.9' }
  });
  const html = await resp.text();
  try {
    const startIdx = html.indexOf('ytInitialPlayerResponse');
    if (startIdx !== -1) {
      const braceIdx = html.indexOf('{', startIdx);
      if (braceIdx !== -1) {
        let depth = 0, endIdx = -1;
        for (let i = braceIdx; i < html.length; i++) {
          if (html[i] === '{') depth++;
          else if (html[i] === '}') { depth--; if (depth === 0) { endIdx = i + 1; break; } }
        }
        if (endIdx > 0) {
          const data = JSON.parse(html.slice(braceIdx, endIdx));
          title = data?.videoDetails?.title || '';
          preview = data?.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url || '';
        }
      }
    }
  } catch (e) {}
  if (!title) {
    try {
      const oembed = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${id}&format=json`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      const od = await oembed.json();
      title = od.title || '';
      if (!preview) preview = od.thumbnail_url || '';
    } catch (e) {}
  }
  if (!preview) preview = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  const embedUrl = `https://www.youtube.com/embed/${id}?autoplay=1`;
  return { result: embedUrl, title, preview, type: 'embed' };
}

async function twitterSyndication(url) {
  const id = url.match(/\/(\d+)(?:\/|$)/)?.[1];
  if (!id) throw new Error('Invalid Twitter URL');
  const resp = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const data = await resp.json();
  const video = data?.mediaDetails?.find(m => m.type === 'video')?.video_info?.variants
    ?.filter(v => v.content_type === 'video/mp4')
    ?.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))?.[0]?.url;
  if (video) return { result: video, title: data?.text || '' };
  const media = data?.mediaDetails?.[0]?.media_url_https;
  if (media) return { result: media, title: data?.text || '' };
  throw new Error('No media found in tweet');
}

async function snaptikFetch(url) {
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
  const home = await fetch('https://snaptik.app/', { headers: { 'user-agent': UA } });
  const homeHtml = await home.text();
  const token = homeHtml.match(/<input[^>]*name="token"[^>]*value="([^"]+)"/)?.[1];
  if (!token) throw new Error('No snaptik token');
  const form = new URLSearchParams();
  form.append('url', url);
  form.append('token', token);
  const resp = await fetch('https://snaptik.app/abc2.php', {
    method: 'POST',
    headers: { 'accept': '*/*', 'content-type': 'application/x-www-form-urlencoded', 'origin': 'https://snaptik.app', 'referer': 'https://snaptik.app/', 'user-agent': UA },
    body: form.toString(),
  });
  const text = await resp.text();
  const enc = getEncodedSnapApp(text);
  if (!enc) throw new Error('Failed to get snaptik encoded data');
  const decoded = decodeSnapApp(enc);
  const innerHtml = decoded.split('$("#download").innerHTML = "')[1]?.split('";')[0];
  if (!innerHtml) throw new Error('Failed to extract snaptik HTML');
  const cleanHtml = decodeJsString(innerHtml);
  const link = cleanHtml.match(/<a[^>]*href="([^"]+)"[^>]*>/);
  if (!link) throw new Error('No download link from snaptik');
  const title = decodeHtmlEntities(cleanHtml.match(/<div class="video-title">([\s\S]*?)<\/div>/)?.[1]?.trim() || '');
  const thumb = cleanHtml.match(/<img[^>]*src="(https?[^"]+)"[^>]*>/)?.[1] || '';
  const author = decodeHtmlEntities(cleanHtml.match(/<div class="info">[\s\S]*?<span>([\s\S]*?)<\/span>/)?.[1]?.trim() || '');
  const fullTitle = [title, author].filter(Boolean).join(' — ');
  return { result: link[1], title: fullTitle, preview: thumb };
}

async function instagramScrape(url) {
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const html = await resp.text();
  const og = html.match(/og:title.*?content="([^"]+)"/);
  const title = og ? decodeHtmlEntities(og[1].replace(/&quot;/g, '"').trim()) : '';
  const vidUrl = html.match(/<meta[^>]*property="og:video"[^>]*content="([^"]+)"/)?.[1]
    || html.match(/<video[^>]*src="([^"]+)"/)?.[1]
    || html.match(/"video_url":"([^"]+)"/)?.[1];
  if (vidUrl) return { result: vidUrl, title };
  const allImgs = [...new Set([...html.matchAll(/"display_url":"([^"]+)"/g)].map(m => m[1]))];
  if (allImgs.length) return { result: allImgs[0], title, media: allImgs, type: 'image' };
  const ldMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/);
  if (ldMatch) try { const ld = JSON.parse(ldMatch[1]); const u = ld.thumbnailUrl || ld.image; if (u) return { result: Array.isArray(u) ? u[0] : u, title, media: Array.isArray(u) ? u : [u], type: 'image' }; } catch (e) {}
  const imgUrl = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/)?.[1]
    || html.match(/<img[^>]*class="[^"]*photo[^"]*"[^>]*src="([^"]+)"/)?.[1];
  if (imgUrl) return { result: imgUrl, title, type: 'image' };
  return { result: '', title };
}

async function fvidgoFacebook(url) {
  const enc = rsaEncrypt(Date.now().toString(), FVIDGO_PUB_KEY);
  const resp = await fetch('https://api.hitube.io/st-tik-video/fb/dl2?url=' + encodeURIComponent(url) + '&sessionid=' + Date.now(), {
    headers: { 'X-Secure-Message': enc }
  });
  const data = await resp.json();
  if (data.code !== 200 || !data.result?.fbBos?.length) throw new Error('fvidgo: no media');
  const title = data.result.title || '';
  const media = data.result.fbBos.map(item => {
    const jwt = item.multiResolutions?.[0]?.url || item.url;
    return 'https://api.hitube.io/st-tik/token/' + jwt;
  });
  return { result: media[0], title, media, type: 'image' };
}

function addFvidgoAuth(fetchOpts) {
  const enc = rsaEncrypt(Date.now().toString(), FVIDGO_PUB_KEY);
  fetchOpts.headers = fetchOpts.headers || {};
  fetchOpts.headers['X-Secure-Message'] = enc;
}

async function genericFallback(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await resp.text();
  const ogVideo = html.match(/<meta[^>]*property="og:video"[^>]*content="([^"]+)"/);
  const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
  if (ogVideo) return { result: ogVideo[1], title: ogTitle?.[1] || '' };
  const vidSrc = html.match(/<video[^>]*src="([^"]+)"/);
  if (vidSrc) return { result: vidSrc[1], title: ogTitle?.[1] || '' };
  throw new Error('No video found');
}

export async function onRequest(context) {
  const request = context.request;
  const cors = handleOptions(request);
  if (cors) return cors;

  const params = new URL(request.url).searchParams;
  const mode = params.get('mode');

  // Metadata-only mode: scrape title + preview without resolving download URL (fast)
  if (mode === 'metadata') {
    const pageUrl = params.get('url');
    if (!pageUrl) return jsonResponse({ error: 'Missing url' }, 400);
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    try {
      const resp = await fetch(decodeURIComponent(pageUrl), {
        headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
        redirect: 'follow',
      });
      const html = await resp.text();
      const decode = (s) => s ? s.replace(/&#x([\dA-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&apos;/g, "'").trim() : '';
      const desc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
      const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
      const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i);
      const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/i);
      const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const title = decode(desc?.[1] || ogTitle?.[1] || ogDesc?.[1] || pageTitle?.[1] || '');
      const image = ogImage?.[1] || '';
      return jsonResponse({ title, preview: image });
    } catch (e) {
      return jsonResponse({ error: 'Failed to fetch metadata' }, 502);
    }
  }

  // Thumbnail proxy mode: fetch and return image with CORS headers
  if (mode === 'preview') {
    const imgUrl = params.get('url');
    if (!imgUrl) return jsonResponse({ error: 'Missing url' }, 400);
    const decodedUrl = decodeURIComponent(imgUrl);
    const fetchOpts = { headers: { 'User-Agent': 'Mozilla/5.0' } };
    if (decodedUrl.includes('api.hitube.io')) addFvidgoAuth(fetchOpts);
    const resp = await fetch(decodedUrl, fetchOpts);
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(resp.body, { status: resp.status, headers });
  }

  // Download proxy mode: fetch video and return with filename header
  if (mode === 'download') {
    const dlUrl = params.get('url');
    const dlName = params.get('name') || 'video';
    const dlType = params.get('type') || '';
    if (!dlUrl) return jsonResponse({ error: 'Missing url' }, 400);
    const decodedUrl = decodeURIComponent(dlUrl);
    const fetchOpts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'video/mp4,video/webm,video/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.facebook.com/',
        'Origin': 'https://www.facebook.com',
      },
    };
    if (decodedUrl.includes('api.hitube.io')) addFvidgoAuth(fetchOpts);
    const resp = await fetch(decodedUrl, fetchOpts);
    const headers = new Headers(resp.headers);
    const safeName = dlName.replace(/[^\x20-\x7E]/g, ' ').replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'video';
    const ext = dlType === 'image' ? 'jpg' : (dlUrl.match(/\.(mp4|webm|mkv|avi|mov|jpg|jpeg|png|webp|gif)(\?|$)/)?.[1] || 'mp4');
    const cleanOrig = dlName.replace(/[\\\/:*?"<>|]/g, '_').trim() || 'video';
    const enc = encodeURIComponent(cleanOrig).replace(/%20/g, ' ');
    headers.set('Content-Disposition', `attachment; filename="${safeName}.${ext}"; filename*=UTF-8''${enc}.${ext}`);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: resp.status, headers });
  }

  const urlParam = params.get('url');
  if (!urlParam) return jsonResponse({ error: 'Missing url parameter' }, 400);

  const url = decodeURIComponent(urlParam);

  try {
    if (url.includes('tiktok.com') || url.includes('tikwm.com')) {
      let result;
      try { result = await abTikTok(url); } catch (e) {}
      if (!result) try { result = await snaptikFetch(url); } catch (e) {}
      if (!result) try { result = await tikwmFetch(url); } catch (e) {}
      if (!result) return jsonResponse({ error: 'TikTok download failed' }, 500);
      // Always try to get a fresh title from OEmbed
      let freshTitle = '';
      try {
        const oembed = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const o = await oembed.json();
        const t = (o.title || o.description || '').replace(/ - TikTok$/, '').trim();
        if (t) freshTitle = t;
      } catch (e) {}
      if (!freshTitle) {
        try {
          const page = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = await page.text();
          const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/);
          if (ogDesc) freshTitle = decodeHtmlEntities(ogDesc[1].trim());
          else {
            const ogT = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
            if (ogT) freshTitle = decodeHtmlEntities(ogT[1].trim());
            else {
              const mt = html.match(/<title[^>]*>([\s\S]*?)<\/title>/);
              if (mt) freshTitle = decodeHtmlEntities(mt[1].replace(/ - TikTok$/, '').trim());
            }
          }
        } catch (e2) {}
      }
      if (freshTitle && freshTitle !== 'TikTok - Make Your Day' && freshTitle !== 'TikTok') result.title = freshTitle;
      return jsonResponse(result);
    }

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      try { return jsonResponse(await abYoutube(url)); } catch (e) {}
      try { return jsonResponse(await ytScrapeFallback(url)); } catch (e) {}
      return jsonResponse({ error: 'YouTube download failed' }, 500);
    }

    if (url.includes('facebook.com') || url.includes('fb.watch')) {
      let result;
      try { result = await fvidgoFacebook(url); } catch (e) {}
      if (!result) try { result = await snapsaveFetch(url); } catch (e) {}
      if (!result) {
        try {
          const page = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
          const html = await page.text();
          const urlMatch = html.match(/"playable_url":"([^"]+)"/) || html.match(/"playable_url_quality_hd":"([^"]+)"/) || html.match(/"src":"([^"]+\.mp4)"/) || html.match(/video_url":"([^"]+)"/);
          if (urlMatch) result = { result: decodeHtmlEntities(urlMatch[1]), title: '' };
        } catch (e2) {}
      }
      if (!result) {
        async function fbScrape(hostUrl) {
          const page = await fetch(hostUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
          const html = await page.text();
          const img = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/)?.[1];
          if (!img) throw new Error('no image');
          const title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/)?.[1] || '';
          return { result: decodeHtmlEntities(img), title: decodeHtmlEntities(title.trim()), type: 'image', media: [decodeHtmlEntities(img)] };
        }
        try { result = await fbScrape(url); } catch (e) {
          try { result = await fbScrape(url.replace('://www.facebook.com', '://mbasic.facebook.com').replace('://facebook.com', '://mbasic.facebook.com').replace('://fb.watch', '://mbasic.facebook.com')); } catch (e2) {}
        }
      }
      if (!result) return jsonResponse({ error: 'Facebook download failed' }, 500);
      try {
        const page = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
        const html = await page.text();
        const desc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/);
        if (desc) result.title = decodeHtmlEntities(desc[1].trim());
        else {
          const ogt = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
          if (ogt && !ogt[1].includes('Facebook')) result.title = decodeHtmlEntities(ogt[1].trim());
          else {
            const t = html.match(/<title>([\s\S]*?)<\/title>/);
            if (t) result.title = decodeHtmlEntities(t[1].replace(/ \| Facebook$/, '').trim());
          }
        }
      } catch (e3) {}
      return jsonResponse(result);
    }

    if (url.includes('instagram.com')) {
      let result;
      try {
        result = await abInstagram(url);
        if (!result.media || result.media.length === 0) {
          const scrape = await instagramScrape(url);
          if (scrape.media) result.media = scrape.media;
        }
        if (!result.title) {
          const scrape = await instagramScrape(url);
          if (scrape.title) result.title = scrape.title;
        }
        return jsonResponse(result);
      } catch (e) {}
      try {
        result = await snapsaveFetch(url);
        const scrape = await instagramScrape(url);
        if (scrape.title) result.title = scrape.title;
        if (scrape.type) result.type = scrape.type;
        if (scrape.media) result.media = scrape.media;
        return jsonResponse(result);
      } catch (e) {}
      const fallback = await instagramScrape(url);
      if (fallback.result) return jsonResponse(fallback);
      return jsonResponse({ error: 'Instagram download failed' }, 500);
    }

    if (url.includes('twitter.com') || url.includes('x.com')) {
      try { return jsonResponse(await snapsaveFetch(url)); } catch (e) {}
      try { return jsonResponse(await twitterSyndication(url)); } catch (e) {}
      return jsonResponse({ error: 'Twitter download failed' }, 500);
    }

    return jsonResponse(await genericFallback(url));
  } catch (e) {
    return jsonResponse({ error: e.message || 'All methods failed' }, 500);
  }
}


