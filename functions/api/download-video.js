import { jsonResponse, handleOptions } from './_utils.js';

async function createSnapxToken() {
  const secret = 'S7O1qf3ZRyNLYA';
  const b64url = (obj) => btoa(JSON.stringify(obj)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = b64url({ alg: 'HS256', typ: 'JWT' }) + '.' + b64url({ exp: Math.floor(Date.now() / 1000) + 600 });
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return data + '.' + sigB64;
}

async function snapxFetch(url) {
  const token = await createSnapxToken();
  const resp = await fetch(`https://api.snapx.info/v1/tiktok?url=${encodeURIComponent(url)}`, {
    headers: { 'X-App-Id': '22120300515132', 'X-App-Token': token, 'Content-Type': 'application/json; charset=utf-8' }
  });
  const jsonResp = await resp.json();
  if (jsonResp.status !== '100') throw new Error(jsonResp.message || 'snapx tiktok: request failed');
  const videoUrl = jsonResp.dl_full_hd || jsonResp.dl || jsonResp.snapxcdn || jsonResp.url;
  if (!videoUrl) throw new Error('No video URL from snapx tiktok');
  return { result: videoUrl, title: jsonResp.des || jsonResp.name || '', preview: jsonResp.thumbnail || jsonResp.video_thumbnail || '', media: [{ url: videoUrl, type: 'video' }], type: 'video' };
}

async function snapxInstagram(url) {
  const token = await createSnapxToken();
  const resp = await fetch(`https://api.snapx.info/v1/instagram?url=${encodeURIComponent(url)}`, {
    headers: { 'X-App-Id': '22120300515132', 'X-App-Token': token, 'Content-Type': 'application/json; charset=utf-8' }
  });
  const jsonResp = await resp.json();
  if (jsonResp.status_code !== 0) throw new Error(jsonResp.message || 'snapx instagram: request failed');
  const data = jsonResp.data;
  if (!data) throw new Error('snapx instagram: no data');
  const items = data.items || [];
  const allUrls = [];
  for (const item of items) {
    const subItems = item.items;
    if (subItems && subItems.length) {
      for (const si of subItems) { if (si.url) allUrls.push({ url: si.url, type: 'image' }); }
    } else if (item.video_url) {
      allUrls.push({ url: item.video_url, type: 'video' });
    } else if (item.url) {
      allUrls.push({ url: item.url, type: item.type === 'video' ? 'video' : 'image' });
    } else if (item.display_url) {
      allUrls.push({ url: item.display_url, type: 'image' });
    }
  }
  if (!allUrls.length) {
    if (data.video_url) allUrls.push({ url: data.video_url, type: 'video' });
    else if (data.display_url) allUrls.push({ url: data.display_url, type: 'image' });
  }
  if (!allUrls.length) throw new Error('No media URL from snapx instagram');
  const firstUrl = allUrls[0].url;
  const isVideo = allUrls.some(m => m.type === 'video');
  return { result: firstUrl, title: data.title || data.shortcode || '', preview: data.display_url || '', media: allUrls, type: isVideo ? 'video' : 'image' };
}

async function snapxFacebook(url) {
  const [token, pageResp] = await Promise.all([
    createSnapxToken(),
    fetch(url, { signal: AbortSignal.timeout(8000) }).catch(() => null)
  ]);
  const pageTitle = pageResp?.ok ? await pageResp.text().then(html => {
    let m = html.match(/<meta\s[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
    if (m) return m[1].replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c));
    m = html.match(/<title>([^<]+)<\/title>/i);
    return m ? m[1].trim() : null;
  }).catch(() => null) : null;
  const resp = await fetch(`https://api.snapx.info/v1/fb?url=${encodeURIComponent(url)}`, {
    headers: { 'X-App-Id': '22120300515132', 'X-App-Token': token, 'Content-Type': 'application/json; charset=utf-8' }
  });
  const jsonResp = await resp.json();
  if (jsonResp.error !== false) throw new Error(jsonResp.message || 'snapx facebook: request failed');
  const d = jsonResp.data;
  if (!d) throw new Error('snapx facebook: no data');
  const videoUrl = d.hd || d.sd || d.thumbnail;
  if (!videoUrl) throw new Error('No media URL from snapx facebook');
  const isVideo = !!(d.hd || d.sd);
  const snapxTitle = d.title || d.des || '';
  const title = pageTitle && !/^Facebook\s+(Video|Post|Photo|Reel)\s*#/i.test(pageTitle) ? pageTitle : snapxTitle;
  return { result: videoUrl, title, preview: d.thumbnail || '', media: [{ url: videoUrl, type: isVideo ? 'video' : 'image' }], type: isVideo ? 'video' : 'image' };
}

async function snapxTwitter(url) {
  const token = await createSnapxToken();
  const resp = await fetch(`https://api.snapx.info/v1/twitter?url=${encodeURIComponent(url)}`, {
    headers: { 'X-App-Id': '22120300515132', 'X-App-Token': token, 'Content-Type': 'application/json; charset=utf-8' }
  });
  const jsonResp = await resp.json();
  const sc = jsonResp.status_code;
  if (sc === null || sc === undefined || sc !== 0) throw new Error(jsonResp.message || 'snapx twitter: request failed');
  const d = jsonResp.data;
  if (!d) throw new Error('snapx twitter: no data');
  const playlists = d.playlists || [];
  let videoUrl = '';
  for (const p of playlists) {
    if (p.playlist_url) { videoUrl = p.playlist_url; if (p.resolution === 'hd' || p.resolution === '720') break; }
  }
  if (!videoUrl && playlists.length) videoUrl = playlists[0].playlist_url;
  if (!videoUrl) throw new Error('No media URL from snapx twitter');
  return { result: videoUrl, title: d.description || d.author_name || '', preview: d.cover_url || '', media: [{ url: videoUrl, type: 'video' }], type: 'video' };
}

export async function onRequest(context) {
  const request = context.request;
  const cors = handleOptions(request);
  if (cors) return cors;

  const params = new URL(request.url).searchParams;
  const mode = params.get('mode');

  if (mode === 'preview') {
    const imgUrl = params.get('url');
    if (!imgUrl) return jsonResponse({ error: 'Missing url' }, 400);
    const resp = await fetch(decodeURIComponent(imgUrl), { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const headers = new Headers(resp.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cache-Control', 'public, max-age=86400');
    return new Response(resp.body, { status: resp.status, headers });
  }

  if (mode === 'download') {
    const dlUrl = params.get('url');
    const dlName = params.get('name') || 'video';
    if (!dlUrl) return jsonResponse({ error: 'Missing url' }, 400);
    const decodedUrl = decodeURIComponent(dlUrl);
    const resp = await fetch(decodedUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
        'Accept': 'video/mp4,video/webm,video/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    const headers = new Headers(resp.headers);
    const safeName = dlName.replace(/[^\x20-\x7E]/g, ' ').replace(/[\\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim() || 'video';
    const ext = dlUrl.match(/\.(mp4|webm|mkv|avi|mov|jpg|jpeg|png|webp|gif)(\?|$)/)?.[1] || 'mp4';
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
    if (url.includes('tiktok.com')) {
      const result = await snapxFetch(url);
      try {
        const oembed = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const o = await oembed.json();
        const t = (o.title || o.description || '').replace(/ - TikTok$/, '').trim();
        if (t && t !== 'TikTok - Make Your Day' && t !== 'TikTok') result.title = t;
      } catch (e) {}
      return jsonResponse(result);
    }

    if (url.includes('facebook.com') || url.includes('fb.watch')) {
      const result = await snapxFacebook(url);
      return jsonResponse(result);
    }

    if (url.includes('instagram.com')) {
      const result = await snapxInstagram(url);
      return jsonResponse(result);
    }

    if (url.includes('twitter.com') || url.includes('x.com')) {
      const result = await snapxTwitter(url);
      return jsonResponse(result);
    }

    return jsonResponse({ error: 'Unsupported URL' }, 400);
  } catch (e) {
    return jsonResponse({ error: e.message || 'Request failed' }, 500);
  }
}
