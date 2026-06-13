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
  const resp = await fetch(`https://backend1.tioo.eu.org/${endpoint}?url=${encodeURIComponent(url)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return await resp.json();
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
  return {
    result: data[0].url,
    title: '',
    preview: data[0]?.thumbnail || '',
    media: allUrls,
    type: 'image'
  };
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
        let depth = 0;
        let endIdx = -1;
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

  // Thumbnail proxy mode: fetch and return image with CORS headers
  if (mode === 'preview') {
    const imgUrl = params.get('url');
    if (!imgUrl) return jsonResponse({ error: 'Missing url' }, 400);
    const resp = await fetch(decodeURIComponent(imgUrl), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
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
    const resp = await fetch(decodeURIComponent(dlUrl), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const headers = new Headers(resp.headers);
    const safeName = dlName.replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'video';
    const ext = dlType === 'image' ? 'jpg' : (dlUrl.match(/\.(mp4|webm|mkv|avi|mov|jpg|jpeg|png|webp|gif)(\?|$)/)?.[1] || 'mp4');
    headers.set('Content-Disposition', `attachment; filename="${safeName}.${ext}"`);
    headers.set('Access-Control-Allow-Origin', '*');
    return new Response(resp.body, { status: resp.status, headers });
  }

  const urlParam = params.get('url');
  if (!urlParam) return jsonResponse({ error: 'Missing url parameter' }, 400);

  const url = decodeURIComponent(urlParam);

  try {
    if (url.includes('tiktok.com') || url.includes('tikwm.com')) {
      let result;
      if (url.includes('/photo/')) {
        try { result = await abTikTok(url); } catch (e) {}
      }
      if (!result) try { result = await snaptikFetch(url); } catch (e) {}
      if (!result) try { result = await tikwmFetch(url); } catch (e) {}
      if (!result) try { result = await abTikTok(url); } catch (e) {}
      if (!result) return jsonResponse({ error: 'TikTok download failed' }, 500);
      try {
        const oembed = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, {
          headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const o = await oembed.json();
        if (o.title || o.description) result.title = o.title || o.description;
      } catch (e) {
        try {
          const page = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = await page.text();
          const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/);
          if (m) result.title = decodeHtmlEntities(m[1].replace(/ - TikTok$/, '').trim());
        } catch (e2) {}
      }
      return jsonResponse(result);
    }

    if (url.includes('youtube.com') || url.includes('youtu.be')) {
      try { return jsonResponse(await abYoutube(url)); } catch (e) {}
      try { return jsonResponse(await ytScrapeFallback(url)); } catch (e) {}
      return jsonResponse({ error: 'YouTube download failed' }, 500);
    }

    if (url.includes('facebook.com') || url.includes('fb.watch')) {
      let result;
      try { result = await snapsaveFetch(url); } catch (e) {}
      if (!result) {
        try {
          const page = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
          const html = await page.text();
          const urlMatch = html.match(/"playable_url":"([^"]+)"/) || html.match(/"playable_url_quality_hd":"([^"]+)"/) || html.match(/"src":"([^"]+\.mp4)"/) || html.match(/video_url":"([^"]+)"/);
          if (urlMatch) result = { result: decodeHtmlEntities(urlMatch[1]), title: '' };
        } catch (e2) {}
      }
      if (!result) return jsonResponse({ error: 'Facebook download failed' }, 500);
      if (!result.title || result.title === '...' || result.title === '….') {
        try {
          const page = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
          const html = await page.text();
          const ogt = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/);
          if (ogt) result.title = decodeHtmlEntities(ogt[1].trim());
          else {
            const t = html.match(/<title>([\s\S]*?)<\/title>/);
            if (t) result.title = decodeHtmlEntities(t[1].replace(/ \| Facebook$/, '').trim());
          }
        } catch (e3) {}
      }
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


