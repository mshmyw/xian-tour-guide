/*! 秦俑小导游 · Service Worker
 *
 * 目标：第一次在酒店 Wi-Fi 打开过之后，景区里没信号也能正常听。
 *
 * 对带 Range 的媒体请求返回缓存切片，保证 iOS Safari 离线播放。
 * 激活新版本时只清理本项目的旧缓存，不影响同域的其它项目。
 */
const VERSION = 'v29';                          // ★ 改了讲解词/图片/音频后 +1
const CACHE = 'qin-tour-' + VERSION;
const PREFIX = 'qin-tour-';                    // 只清理自己，别动同域其它项目

/* 预缓存：只放「没有它页面就起不来」的壳文件。
   音频和图片走运行时按需缓存（见 fetch 分支），避免新增内容时忘记同步清单。 */
const CORE = [
  './',
  './index.html',
  './styles.css',
  './data.js',
  './app.js',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './apple-touch-icon.png'
];

/* 壳文件：这些缓存失败必须让安装失败，否则会出现「装着但残」的假成功 */
const SHELL = ['./index.html', './styles.css', './data.js', './app.js'];

const CACHEABLE = /\.(?:js|css|html|json|png|jpe?g|webp|svg|ico|mp3|m4a|aac|ogg|wav|woff2?)$/i;
const NAV_TIMEOUT = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const failed = [];
    await Promise.all(CORE.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        failed.push(url);
      }
    }));
    await self.skipWaiting();

    /* 壳文件缺失 = 离线根本打不开，必须让安装失败（浏览器会保留旧的 SW） */
    const shellMissing = failed.filter((u) => SHELL.indexOf(u) >= 0);
    if (shellMissing.length) throw new Error('核心文件缓存失败: ' + shellMissing.join(', '));

    /* 其它文件（图标等）失败只是不完美，通知页面把「离线就绪」标灰 */
    if (failed.length) {
      const clients = await self.clients.matchAll();
      clients.forEach((c) => c.postMessage({ type: 'cache-incomplete', failed: failed }));
    }
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    /* 只删自己的旧版本，别碰同域其它项目的缓存 */
    await Promise.all(
      keys.filter((k) => k.indexOf(PREFIX) === 0 && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  /* ---------------- 页面导航：网络优先（带超时），失败或非 2xx 回缓存 ---------------- */
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), NAV_TIMEOUT);
        const fresh = await fetch(req, { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(timer);
        if (!fresh || !fresh.ok) throw new Error('bad status ' + (fresh && fresh.status));
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (err) {
        return (await cache.match('./index.html', { ignoreSearch: true })) ||
               (await cache.match('./', { ignoreSearch: true })) ||
               new Response('离线状态。请先联网打开一次，之后就能离线使用。', {
                 status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
               });
      }
    })());
    return;
  }

  /* ---------------- 音频 / 视频：Range 支持 ---------------- */
  const isMedia = req.destination === 'audio' || req.destination === 'video' ||
                  /\.(?:mp3|m4a|aac|ogg|wav)$/i.test(url.pathname);
  const rangeHeader = req.headers.get('range');

  if (isMedia && rangeHeader) {
    e.respondWith(handleRange(req, rangeHeader));
    return;
  }

  /* 音频/视频：在线时优先取网络（否则改过的录音会被旧缓存卡住，
     家人听到的是上一版内容），失败或离线时回缓存。 */
  if (isMedia) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const key = new Request(new URL(req.url).href);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.status === 200 && fresh.type === 'basic') {
          cache.put(key, fresh.clone());
        }
        return fresh;
      } catch (err) {
        return (await cache.match(key, { ignoreSearch: true })) ||
               (await cache.match(req, { ignoreSearch: true })) ||
               new Response('', { status: 504, statusText: 'offline' });
      }
    })());
    return;
  }

  /* ---------------- 其它静态资源：缓存优先 + 后台更新 ---------------- */
  if (!CACHEABLE.test(url.pathname) && req.destination !== 'image') return;

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) {
      /* 后台更新：失败静默（Service Worker 里拿不到 navigator.onLine） */
      fetch(req).then((res) => {
        if (res && res.ok && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
      }).catch(() => {});
      return hit;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'offline' });
    }
  })());
});

/* 把「Range 请求」翻译成对完整缓存的切片返回（206）。
   关键点：缓存时必须用「不带 Range 的完整 GET」，否则永远只能拿到 206、永远存不进去。 */
async function handleRange(req, rangeHeader) {
  const cacheKey = new Request(new URL(req.url).href);      // 干净的 key，不带 Range
  const cache = await caches.open(CACHE);
  let full = await cache.match(cacheKey);

  if (!full) {
    try {
      const res = await fetch(cacheKey);                      // ← 不带 Range 的完整请求
      if (res && res.ok && res.status === 200 && res.type === 'basic') {
        cache.put(cacheKey, res.clone());
        full = res;
      } else if (res) {
        return res;                                           // 服务器本来就回了 206/404，透传
      }
    } catch (err) { /* 掉到下面的兜底 */ }
  }
  if (!full) return new Response('', { status: 504, statusText: 'offline' });
  if (full.status === 206) return full;

  const buf = await full.arrayBuffer();
  const size = buf.byteLength;
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);

  /* 无 Range 或写法无法解析：整段返回 */
  if (!m) return new Response(buf, { status: 200, headers: baseHeaders(full, size) });

  let start, end;
  if (m[1] === '' && m[2] !== '') {
    /* S1：bytes=-500 表示「最后 500 字节」，不是开头 500 */
    const tail = parseInt(m[2], 10);
    start = Math.max(0, size - tail);
    end = size - 1;
  } else {
    start = m[1] ? parseInt(m[1], 10) : 0;
    end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
  }

  if (isNaN(start) || isNaN(end) || start >= size || start > end) {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': 'bytes */' + size, 'Accept-Ranges': 'bytes' }
    });
  }

  const chunk = buf.slice(start, end + 1);
  const headers = baseHeaders(full, chunk.byteLength);
  headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  headers['Content-Length'] = String(chunk.byteLength);
  return new Response(chunk, { status: 206, statusText: 'Partial Content', headers });
}

function baseHeaders(res, len) {
  return {
    'Content-Type': res.headers.get('Content-Type') || 'audio/mpeg',
    'Content-Length': String(len),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=31536000'
  };
}

/* 页面可以问版本，排查「为什么还是旧内容」 */
self.addEventListener('message', (e) => {
  if (e.data === 'version' && e.source) {
    e.source.postMessage({ type: 'version', version: VERSION, cache: CACHE });
    return;
  }
  if (e.data && e.data.type === 'cache-all' && e.source) {
    const source = e.source;
    const assets = Array.from(new Set(e.data.assets || []));
    e.waitUntil(cacheAll(assets, source));
  }
});

/* 绿点的唯一依据：数据里引用的所有封面和音频都已确认在缓存中。 */
async function cacheAll(assets, source) {
  const cache = await caches.open(CACHE);
  const failed = [];
  let done = 0;
  source.postMessage({ type: 'cache-progress', done: done, total: assets.length });

  for (const asset of assets) {
    try {
      const url = new URL(asset, self.registration.scope).href;
      const key = new Request(url);
      let hit = await cache.match(key, { ignoreSearch: true });
      if (!hit) {
        const res = await fetch(new Request(url, { cache: 'reload' }));
        if (!res || !res.ok || res.status !== 200) throw new Error('bad status');
        await cache.put(key, res.clone());
        hit = res;
      }
      if (!hit) throw new Error('missing cache');
    } catch (err) {
      failed.push(asset);
    }
    done++;
    source.postMessage({ type: 'cache-progress', done: done, total: assets.length });
  }

  source.postMessage(failed.length
    ? { type: 'cache-incomplete', failed: failed, done: done, total: assets.length }
    : { type: 'cache-ready', total: assets.length });
}
