/*! 秦俑小导游 · 逻辑（语音优先）
 *
 * 用户是「几乎不识字的老人 + 4 岁不识字孩子」：
 *   - 主路径只有一个按钮：中间的大播放键。点一次之后自动一段段往下放。
 *   - 屏幕只保留地点、播放操作、本段进度和跟读字幕。
 *   - 用法靠语音说明；字幕只帮助听清，不把阅读变成使用门槛。
 *
 * 播放回调会校验当前段落，存储与音频失败都有兜底，避免串音或整页卡死。
 */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  /* 存储保护：Safari 阻止 Cookie 时 getItem/setItem 会抛 SecurityError，
     不包起来会让整个初始化中断（整页假死），或在第 1 段后永久停掉连播。 */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  };

  /* ============================================================ 1. 数据 */
  /* data.js 会显式挂到 window，拿不到就进入下方的错误提示。 */
  const TOUR = (typeof window !== 'undefined' && window.TOUR) || {};
  /* skip 列表里的地点暂不展示（内容保留在 data.js，删掉 skip 即可恢复） */
  const SKIP = TOUR.skip || [];
  const SPOTS = (TOUR.spots || []).filter((s) => s && SKIP.indexOf(s.id) < 0);

  const voice = $('voice');
  const done = new Set(store.get('qin-done', []));      // 「地点id:段号」已听完

  const state = {
    spot: 0,
    track: 0,
    playing: false,
    unlocked: false,
    silentChecked: false,
    speechMode: false
  };

  /* ============================================================ 2. 数据存取 */
  const tracksOf = (spot) => spot.tracks.concat(spot.kids ? [spot.kids] : []);
  const currentSpot = () => SPOTS[state.spot];
  const currentTrack = () => tracksOf(currentSpot())[state.track];
  const keyOf = (si, ti) => SPOTS[si].id + ':' + ti;
  const currentKey = () => keyOf(state.spot, state.track);
  const spotDone = (i) => tracksOf(SPOTS[i]).every((_, n) => done.has(keyOf(i, n)));
  const totalTracks = () => SPOTS.reduce((n, s) => n + tracksOf(s).length, 0);
  const doneCount = () => SPOTS.reduce((n, s, i) =>
    n + tracksOf(s).filter((_, k) => done.has(keyOf(i, k))).length, 0);

  function markDone() {
    const k = currentKey();
    if (done.has(k)) return false;              // 已经记过，不重复持久化
    done.add(k);
    store.set('qin-done', Array.from(done));
    return true;
  }

  /* ============================================================ 3. 音频状态机
     每次播放有一个「代次」gen。任何异步回调回来先比对 gen，过期就退出 ——
         不会再出现「抹掉别人刚设的 src / 改播上一段」。
     playingKey 记录「正在播的是哪一段」，ended 回来时校验归属。 */
  let gen = 0;
  let playingKey = null;
  let wantPlay = false;
  let retryArmed = false;
  let wakeLock = null;
  let silentTimer = null;
  let drawerOpen = false;
  let speechStart = 0;
  let speechTimer = null;
  let speechKey = null;
  let cacheState = 'waiting';
  let cacheDone = 0;
  let cacheTotal = 0;

  const playWithTimeout = (el, ms) => Promise.race([
    el.play(),
    new Promise((_, rej) => setTimeout(() => {
      const e = new Error('play timeout'); e.name = 'TimeoutError'; rej(e);
    }, ms || 5000))
  ]);

  /* iOS / 部分安卓必须由「用户手势」里调用 play()，这里做一次静音解锁 */
  function unlock() {
    if (state.unlocked) return;
    state.unlocked = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) {
        const ctx = new AC();
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, 22050);
        src.connect(ctx.destination);
        src.start(0);
        setTimeout(() => { try { ctx.close(); } catch (e) {} }, 400);
      }
    } catch (e) {}
    /* 真正的 voice.play() 会紧接着在同一次点击里调用。
       不再对同一 audio 元素做“静音试播”，避免它异步 pause 掉刚开始的正式录音。 */
  }

  /* 静音键检测（P0-4）：播了 1.5 秒进度几乎没走 → 多半是侧边静音开关 */
  function watchSilent() {
    clearTimeout(silentTimer);
    silentTimer = setTimeout(() => {
      if (state.silentChecked || !state.playing) return;
      if (voice.currentTime < 0.25 && !voice.paused && !voice.muted) {
        state.silentChecked = true;
        document.body.classList.add('maybe-silent');
      }
    }, 1500);
  }

  function stopSpeechProgress() {
    clearInterval(speechTimer);
    speechTimer = null;
    speechStart = 0;
    speechKey = null;
    state.speechMode = false;
  }

  /* 兜底朗读：录音缺失或打不开时，用系统中文语音念。
     track 存在时，同步更新字幕和估算进度。 */
  /* 判断这台手机到底能不能朗读。
     注意：不能用 'speechSynthesis' in window —— 属性存在但值为 undefined 时它也是 true
     （部分 WebView 就是这样），要用值本身判断。 */
  const canSpeak = () => ('speechSynthesis' in window)
    && typeof window.speechSynthesis === 'object' && window.speechSynthesis !== null
    && typeof SpeechSynthesisUtterance === 'function';

  /* 挑一个中文音色：优先质量较好的（婷婷/美佳/普通话），否则任意中文音色。
     iOS/安卓自带中文语音，一般都有；真没有时 speak() 会返回 false，由调用方兜底。 */
  let zhVoice = null;
  function pickChineseVoice() {
    try {
      const vs = speechSynthesis.getVoices() || [];
      if (!vs.length) return zhVoice;
      const zh = vs.filter((v) => /zh|cmn|Chinese|中文|普通话/i.test(v.lang + ' ' + v.name));
      if (!zh.length) { zhVoice = null; return null; }
      zhVoice = zh.find((v) => /Tingting|婷婷|Meijia|美佳|Xiaoxiao|晓晓|Google 普通话|Chinese \(China\)|zh-CN/i.test(v.name + ' ' + v.lang))
             || zh[0];
      return zhVoice;
    } catch (e) { return zhVoice; }
  }
  if (canSpeak()) {
    pickChineseVoice();
    try { window.speechSynthesis.onvoiceschanged = pickChineseVoice; } catch (e) {}
  }

  function speak(text, onEnd, track) {
    if (!canSpeak()) return false;
    try { window.speechSynthesis.cancel(); } catch (e) {}
    stopSpeechProgress();
    const u = new SpeechSynthesisUtterance(text || '');
    u.lang = 'zh-CN';
    /* 老人听：慢一点、音调略高（更亲切，也不那么机械）。
       童声彩蛋再高一些，孩子一听就知道是"小朋友频道"。 */
    const isKid = !!track && currentSpot().kids === track;
    u.rate = isKid ? 0.85 : 0.8;
    u.pitch = isKid ? 1.35 : 1.18;
    const zh = pickChineseVoice();
    if (zh) u.voice = zh;
    const my = gen;
    const finish = (completed) => {
      if (my !== gen) return;
      const wasTrack = !!track;
      stopSpeechProgress();
      state.playing = false;
      if (wasTrack && completed) markDone();
      render();
      if (completed && onEnd) onEnd();
    };
    u.onstart = () => {
      if (my !== gen) return;
      state.playing = true;
      if (track) {
        state.speechMode = true;
        speechStart = Date.now() / 1000;
        speechKey = currentKey();
        speechTimer = setInterval(onTime, 250);
      }
      render();
    };
    u.onend = () => finish(true);
    u.onerror = () => finish(false);
    try { window.speechSynthesis.speak(u); } catch (e) { return false; }
    state.playing = true;
    if (track) {
      state.speechMode = true;
      speechStart = Date.now() / 1000;
      speechKey = currentKey();
      speechTimer = setInterval(onTime, 250);
    }
    render();
    return true;
  }

  /* 当前"期望播放"的音频地址。
     切段/切地点时会换 src，浏览器会为被中止的旧请求派发 error 事件——
     如果不比对，就会把"旧源中止"误判成"加载失败"，弹出"这段声音没放出来"。 */
  let expectSrc = null;

  /* 失败提示带 1.2 秒宽限期：很多浏览器（尤其 iOS）在切换音频瞬间会抛一次 error，
     紧接着就正常出声。只要宽限期内真的开始播了，就撤销提示，不让它闪出来。 */
  let failTimer = null;
  /* 判定"真的没声音"的三条依据，全部满足才提示：
       ① 我们确实请求过播放（wantPlay）
       ② 音频元素处于暂停、且播放进度没走
       ③ 距离请求已过了 2.5 秒（够它缓冲和起播）
     这样"切换音频瞬间的 error""被 pause 打断的 play()"都不会再误报。 */
  function waitUntilSilent(reason) {
    clearTimeout(failTimer);
    failTimer = setTimeout(() => {
      if (!wantPlay) return;                       // 用户已经暂停/切走
      if (state.speechMode) return;                // 正在用手机语音念，不算没声音
      if (!voice.paused || (voice.currentTime || 0) > 0.2) return;   // 在响或在走
      if (!expectSrc) return;                      // 当前这一段没有录音
      if (voice.getAttribute('data-src') !== expectSrc) return;      // 已经切到别的段了
      if (voice.error && voice.error.code === 1) return;             // 只是被我们中止的
      flagAudioFail(true, reason);
    }, 2500);
  }
  function cancelFail() { clearTimeout(failTimer); flagAudioFail(false); }

  function flagAudioFail(on, reason) {
    const box = $('retry');
    if (!box) return;
    if (on && reason && box.hidden) {          // 只在"当前没有提示"时改写文案，
      const msg = $('retryMsg');               // 免得后到的旧定时器覆盖掉更准确的原因
      if (msg) msg.textContent = reason;
    }
    document.body.classList.toggle('audio-failed', !!on);
    box.hidden = !on;
  }

  /* 播放当前段。playNow=true 表示载入完就出声 */
  async function play(playNow) {
    const my = ++gen;
    const spot = currentSpot();
    const track = currentTrack();
    if (!spot || !track) return;

    clearTimeout(silentTimer);
    flagAudioFail(false);
    wantPlay = playNow !== false;
    playingKey = null;

    if (canSpeak()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    stopSpeechProgress();
    try { voice.pause(); } catch (e) {}
    state.playing = false;

    const src = (track.audio || [])[0];
    expectSrc = src || null;
    if (!src) { expectSrc = null; if (wantPlay) fallbackSpeak(track, my); render(); return; }

    if (voice.getAttribute('data-src') === src && voice.readyState >= 1) {
      render();
      if (wantPlay) safePlay(my);
      return;
    }

    voice.setAttribute('data-src', src);
    voice.src = src;
    voice.load();
    render();
    if (wantPlay) safePlay(my);
  }

  async function safePlay(my) {
    if (my !== gen) return;
    if (!state.unlocked) { render(); return; }            // 等一次用户手势
    try {
      await playWithTimeout(voice, 5000);
      if (my !== gen) return;
      retryArmed = false;
      stopSpeechProgress();
      state.playing = true;
      playingKey = currentKey();
      watchSilent();
      requestWake();
      mediaSession(currentTrack(), currentSpot());
      render();
    } catch (e) {
      if (my !== gen) return;
      if (e && e.name === 'AbortError') return;                    // 我们自己打断的
      if (e && e.name === 'NotAllowedError') { render(); return; }  // 需要手势，等下次点击
      if (my !== gen) return;
      /* 不立刻报警：有些浏览器会先 reject 再正常出声。
         先观察 2.5 秒，确认真的没声音，才提示用户。 */
      waitUntilSilent('录音没打开，点这里重试');
      setTimeout(() => {
        if (my !== gen) return;
        if (!voice.paused || (voice.currentTime || 0) > 0.2 || state.speechMode) return;  // 已经在响
        fallbackSpeak(currentTrack(), my);        // 真的没声音 → 换手机语音接着讲
      }, 600);
    }
  }

  /* 录音打不开时的兜底：给出可见提示，并用系统语音接着讲 */
  /* 屏幕上显示的文字：去掉尖括号里"只念不显示"的内容（如手机号）。
     必须定义在 fallbackSpeak 之前。 */
  const forScreen = (t) => String(t || '').replace(/<[^>]*>/g, '');

  function fallbackSpeak(track, my) {
    if (state.speechMode && speechKey === currentKey()) return;
    const ok = speak(track.text, () => { if (my === gen) advance(); }, track);
    if (ok) {
      /* 手机上接着念了，就是有声音。
         这里**不弹任何提示**：用户只关心"有没有在讲"，不关心用的是哪一种声音。
         保留"点一下播放键可重试"的能力，但不出现在屏幕上。 */
      retryArmed = true;
      return;
    }
    /* 录音打不开、手机也不能朗读：这才算真的没声音 */
    state.playing = false;
    flagAudioFail(true, '这台手机放不出声音，我把文字显示出来');
    retryArmed = true;
    const box = $('subtitleText');
    if (box) box.textContent = forScreen(track.text);
    document.body.classList.add('no-speech');
    render();
  }

  function pause() {
    gen++;
    clearTimeout(silentTimer);
    wantPlay = false;
    try { voice.pause(); } catch (e) {}
    if (canSpeak()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    stopSpeechProgress();
    state.playing = false;
    playingKey = null;
    releaseWake();
    render();
  }

  function toggle() {
    unlock();
    if (state.playing) { pause(); return; }
    if (retryArmed) { retryArmed = false; play(true); return; }   // 点一下直接重试
    if (voice.getAttribute('data-src') && voice.currentTime > 0 && !voice.ended) {
      safePlay(gen);
      return;
    }
    play(true);
  }

  /* 一段结束 → 自动下一段（调用方已校验归属） */
  function advance() {
    const spot = currentSpot();
    const tracks = tracksOf(spot);
    if (state.track < tracks.length - 1) {
      state.track++;
      render();
      play(true);
      return;
    }
    state.playing = false;
    render();
    celebrate();
    if (state.spot < SPOTS.length - 1) {
      const finishedSpot = state.spot;
      const finishedGen = gen;
      setTimeout(() => {
        if (gen === finishedGen && state.spot === finishedSpot && !state.playing) {
          changeSpot(finishedSpot + 1, true);
        }
      }, 700);
    } else {
      /* 全部听完：画面撒星星 + 出声表扬（孩子不看屏幕也能听到） */
      state.playing = false;
      render();
      setTimeout(() => {
        if (state.playing) return;
        speak(TOUR.praise || '全部听完啦，你真棒！');
      }, 1200);
    }
  }

  /* ============================================================ 4. 切换 */
  function hardStop() {
    gen++;
    clearTimeout(silentTimer);
    try { voice.pause(); } catch (e) {}
    if (canSpeak()) { try { window.speechSynthesis.cancel(); } catch (e) {} }
    stopSpeechProgress();
    state.playing = false;
    playingKey = null;
  }

  function changeSpot(next, autoplay) {
    next = Math.max(0, Math.min(SPOTS.length - 1, next));
    if (next === state.spot) return;
    hardStop();
    state.spot = next;
    state.track = 0;
    closeDrawer();
    render();
    if (autoplay !== false) play(true);
  }

  function jumpTo(si, ti) {
    hardStop();
    state.spot = si;
    state.track = ti || 0;
    closeDrawer();
    render();
    play(true);
  }

  /* 界面上不显示尖括号里的内容（如手机号）：只念给耳朵听。
     现在界面本来就不渲染正文，这里是给以后加字幕时兜底用的。 */
  /* 秒 → m:ss */
  const fmt = (sec) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.round(sec);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  /* 播放进度：左边是"第几段/共几段"，右边是"已播/总长"。
     录音播的时候用音频真实时长；退化成系统朗读时用 data.js 里的 dur 估算。 */
  function onTime() {
    const spot = currentSpot();
    const data = currentTrack();          // 本文件里这个函数就叫 currentTrack
    if (!data || !spot) return;
    const tracks = tracksOf(spot);
    const est = data.dur || 0;

    $('pIndex').textContent = '第 ' + (state.track + 1) + '/' + tracks.length + ' 段';

    if (state.speechMode) {
      const cur = speechStart ? Date.now() / 1000 - speechStart : 0;
      $('pTime').textContent = fmt(cur) + ' / ' + fmt(est);
      $('seek').value = est > 0 ? String(Math.min(1000, Math.round(cur / est * 1000))) : '0';
      updateSubtitle(cur, est);
      return;
    }

    const d = voice.duration;
    const total = isFinite(d) && d > 0 ? d : est;
    const cur = voice.currentTime || 0;
    $('pTime').textContent = fmt(cur) + ' / ' + fmt(total);
    $('seek').value = total > 0 ? String(Math.round(cur / total * 1000)) : '0';
    updateSubtitle(cur, total);
  }

  /* 录音没有逐句时间轴，按句子长度在真实时长上分配，保证字幕短、大、易读。 */
  function subtitleParts(text) {
    const clean = String(text || '').replace(/\s+/g, '').trim();
    if (!clean) return [];
    return clean.match(/[^\u3002！？；!?;]+[\u3002！？；!?;]?/g) || [clean];
  }

  function updateSubtitle(cur, total) {
    const parts = subtitleParts(currentTrack() && currentTrack().text);
    if (!parts.length) { $('subtitleText').textContent = ''; return; }
    const weights = parts.map((s) => Math.max(1, s.replace(/[\u3002！？；!?;，,]/g, '').length));
    const sum = weights.reduce((n, v) => n + v, 0);
    const pos = total > 0 ? Math.max(0, Math.min(1, cur / total)) * sum : 0;
    let acc = 0, index = 0;
    for (let i = 0; i < weights.length; i++) {
      acc += weights[i];
      if (pos <= acc) { index = i; break; }
      index = i;
    }
    $('subtitleText').textContent = parts[index];
  }

  /* ============================================================ 5. 渲染 */
  function render() {
    const spot = currentSpot();
    const track = currentTrack();
    if (!spot || !track) return;
    const tracks = tracksOf(spot);

    $('scene').style.backgroundImage = 'url("images/' + spot.id + '-v2.webp")';

    $('placeName').textContent = spot.name;
    $('placeIcon').textContent = spot.emoji || '🏺';
    $('placeHint').textContent = (state.track === tracks.length - 1 && spot.kids)
      ? '🎁 小朋友故事' : (state.playing ? '🔊 正在讲' : '👂 听故事');

    $('storyDots').innerHTML = tracks.map((_, i) =>
      '<i class="story-dot' + (i === state.track ? ' active' : '') +
      (done.has(keyOf(state.spot, i)) ? ' done' : '') + '"></i>').join('');

    $('prevBtn').disabled = state.spot === 0;
    $('nextBtn').disabled = state.spot === SPOTS.length - 1;
    document.body.classList.toggle('playing', state.playing);
    $('mainPlay').setAttribute('aria-label', state.playing ? '暂停' : '播放');
    $('scenePlay').setAttribute('aria-label', state.playing ? '暂停' : '播放');
    $('stageCount').textContent = '已听完 ' + doneCount() + '/' + totalTracks() + ' 段';

    onTime();
    if (drawerOpen) renderDrawer();
  }

  /* ============================================================ 6. 地点抽屉
     给家长用：一眼看清进度、一键跳到任意地点。老人不需要打开它，也不受影响。 */
  function openDrawer() {
    drawerOpen = true;
    renderDrawer();
    $('drawerMask').hidden = false;
    $('drawer').hidden = false;
    $('stage').inert = true;
    requestAnimationFrame(() => {
      $('drawer').classList.add('show');
      $('drawerClose').focus();
    });
    $('drawerBtn').setAttribute('aria-expanded', 'true');
  }

  function closeDrawer(restoreFocus) {
    if (!drawerOpen) return;
    drawerOpen = false;
    $('drawer').classList.remove('show');
    $('drawerBtn').setAttribute('aria-expanded', 'false');
    $('stage').inert = false;
    setTimeout(() => {
      if (drawerOpen) return;
      $('drawer').hidden = true;
      $('drawerMask').hidden = true;
      if (restoreFocus !== false) $('drawerBtn').focus();
    }, 220);
  }

  /* 抽屉 = 贴纸册 + 遥控器：按「出发前 / 兵马俑 / 丽山园 / 看完后」分组，
     每个地点一行（大图标 = 收集到的贴纸），下面列出它有几段、每段讲什么。 */
  function renderDrawer() {
    const phaseName = {};
    (TOUR.phases || []).forEach((p) => { phaseName[p.id] = p.emoji + ' ' + p.name; });

    const items = SPOTS.map((s, i) => {
      const here = i === state.spot;
      const finished = spotDone(i);
      const mark = here ? '▶' : (finished ? '✅' : '·');
      const segs = tracksOf(s).map((t, k) => {
        const got = done.has(keyOf(i, k));
        const label = t.title || ('第 ' + (k + 1) + ' 段');
        return '<button class="d-seg' + (got ? ' got' : '') +
          (here && k === state.track ? ' now' : '') + '" data-jump="' + i + '" data-track="' + k + '">' +
          '<span class="d-segno">' + (k + 1) + '</span>' +
          '<span class="d-segname">' + label + '</span>' +
        '</button>';
      }).join('');
      return { phase: s.phase || '', html:
        '<div class="d-item' + (here ? ' active' : '') + (finished ? ' finished' : '') + '">' +
          '<button class="d-head" data-jump="' + i + '" data-track="0">' +
            '<span class="d-emoji" aria-hidden="true">' + (s.emoji || '📍') + '</span>' +
            '<span class="d-name">' + s.name + '</span>' +
            '<span class="d-mark" aria-hidden="true">' + mark + '</span>' +
          '</button>' +
          '<div class="d-segs">' + segs + '</div>' +
        '</div>' };
    });

    /* 同一阶段的放在一起，并加上阶段小标题 */
    let html = '', lastPhase = null;
    items.forEach((it) => {
      if (it.phase !== lastPhase) {
        if (it.phase) html += '<p class="d-phase">' + (phaseName[it.phase] || it.phase) + '</p>';
        lastPhase = it.phase;
      }
      html += it.html;
    });
    $('drawerList').innerHTML = html;

    const chip = $('netChip');
    if (chip.dataset.cached === '1') $('drawerNet').textContent = '📶 全部已下载，可以离线用';
    else if (!navigator.onLine) $('drawerNet').textContent = '📶 当前离线，有些内容可能还没下载';
    else if (cacheState === 'failed') $('drawerNet').textContent = '⚠️ 离线内容没下完，请重试';
    else if (cacheTotal) $('drawerNet').textContent = '⏳ 正在下载 ' + cacheDone + '/' + cacheTotal + '，先别断网';
    else $('drawerNet').textContent = '⏳ 正在准备离线内容…';
    $('cacheBtn').hidden = cacheState !== 'failed' || !navigator.onLine;
  }

  function updateOfflineNotice() {
    const offline = $('offline');
    offline.hidden = navigator.onLine;
    offline.textContent = $('netChip').dataset.cached === '1'
      ? '📶 已离线，也能听'
      : '⚠️ 已离线，未下载的内容可能没声音';
  }

  /* ============================================================ 7. 提示与庆祝 */
  function celebrate() {
    $('sparkles').innerHTML = '<i>⭐</i><i>✨</i><i>⭐</i>';
    document.body.classList.add('celebrate');
    clearTimeout(celebrate.t);
    celebrate.t = setTimeout(() => {
      document.body.classList.remove('celebrate');
      $('sparkles').innerHTML = '<i>✨</i><i>⭐</i><i>✨</i>';
    }, 2200);
  }

  /* ============================================================ 8. 屏幕常亮 / 锁屏控制 */
  async function requestWake() {
    if (!('wakeLock' in navigator) || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { wakeLock = null; }
  }
  function releaseWake() {
    if (wakeLock) { try { wakeLock.release(); } catch (e) {} wakeLock = null; }
  }

  function mediaSession(track, spot) {
    if (!('mediaSession' in navigator) || !track || !spot) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || spot.name,
        artist: spot.name,
        album: TOUR.title || '秦俑小导游',
        artwork: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }]
      });
      const set = (n, fn) => { try { navigator.mediaSession.setActionHandler(n, fn); } catch (e) {} };
      set('play', () => { if (!state.playing) toggle(); });
      set('pause', () => { if (state.playing) pause(); });
      set('previoustrack', () => { if (state.track > 0) { state.track--; render(); play(true); } });
      set('nexttrack', () => {
        if (state.track < tracksOf(currentSpot()).length - 1) { state.track++; render(); play(true); }
      });
    } catch (e) {}
  }

  /* ============================================================ 9. 事件绑定 */
  function bind() {
    $('mainPlay').addEventListener('click', toggle);
    $('scenePlay').addEventListener('click', toggle);

    $('prevBtn').addEventListener('click', () => { unlock(); changeSpot(state.spot - 1, true); });
    $('nextBtn').addEventListener('click', () => { unlock(); changeSpot(state.spot + 1, true); });

    /* 第一次的「开始听」：iOS 必须由这次手势解锁 */
    $('startBtn').addEventListener('click', () => {
      unlock();                       // 内部会把 state.unlocked 置为 true（必须在 play 之前）
      state.unlocked = true;
      $('welcome').hidden = true;
      $('stage').inert = false;
      play(true);
    });

    /* 抽屉 */
    $('drawerBtn').addEventListener('click', () => { drawerOpen ? closeDrawer() : openDrawer(); });
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerMask').addEventListener('click', closeDrawer);
    $('cacheBtn').addEventListener('click', startOfflineCache);
    $('drawerList').addEventListener('click', (e) => {
      const item = e.target.closest('[data-jump]');
      if (!item) return;
      unlock();
      jumpTo(+item.getAttribute('data-jump'), +(item.getAttribute('data-track') || 0));
    });

    /* 录音失败后重试 */
    $('retryBtn').addEventListener('click', () => {
      flagAudioFail(false);
      retryArmed = false;
      voice.removeAttribute('data-src');
      unlock();
      play(true);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') changeSpot(state.spot + 1, true);
      else if (e.key === 'ArrowLeft') changeSpot(state.spot - 1, true);
      else if (e.key === ' ') { e.preventDefault(); toggle(); }
      else if (e.key === 'Escape') closeDrawer();
    });

    /* 滑动换地点：区分纵横 + 限时，避免斜划误触发 */
    let sx = 0, sy = 0, st = 0, moving = false;
    const scene = $('scene');
    scene.addEventListener('touchstart', (e) => {
      const t = e.changedTouches[0];
      sx = t.clientX; sy = t.clientY; st = Date.now(); moving = true;
    }, { passive: true });
    scene.addEventListener('touchcancel', () => { moving = false; }, { passive: true });
    scene.addEventListener('touchend', (e) => {
      if (!moving) return;
      moving = false;
      const t = e.changedTouches[0];
      const dx = t.clientX - sx, dy = t.clientY - sy;
      if (Date.now() - st > 700) return;
      if (Math.abs(dx) < 70) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
      changeSpot(state.spot + (dx < 0 ? 1 : -1), true);
    }, { passive: true });

    /* 音频事件：状态只跟着真实事件走 */
    voice.addEventListener('playing', () => {
      state.playing = true;
      wantPlay = true;
      retryArmed = false;
      cancelFail();                      // 出声了就撤销"没放出来"的提示
      playingKey = currentKey();
      render();
      requestWake();
      mediaSession(currentTrack(), currentSpot());
    });
    voice.addEventListener('pause', () => {
      if (voice.ended) return;
      state.playing = false;
      render();
      releaseWake();
    });
    voice.addEventListener('ended', () => {
      if (playingKey && playingKey !== currentKey()) return;   // 不是这一段，忽略
      markDone();
      state.playing = false;
      releaseWake();
      advance();
    });
    voice.addEventListener('error', () => {
      /* 只处理"当前期望播放的那一段"的错误。
         切换到别的段/地点时，旧源的请求被中止也会走到这里——那不是失败，忽略。 */
      const src = voice.getAttribute('data-src');
      if (expectSrc && src && src !== expectSrc) return;
      if (voice.paused && state.playing) state.playing = false;

      /* 这台手机根本不能朗读：没有兜底手段，立刻把文字显示出来，别让用户干等。
         提示只保留"红框"一处（由 fallbackSpeak 负责），屏幕上不再叠第二条。 */
      if (!canSpeak()) {
        const t0 = currentTrack();
        if (t0) {
          /* 真的没声音：红框只保留一处（说明原因），文字直接铺在屏幕上 */
          flagAudioFail(true, '这台手机放不出声音，我把文字显示出来');
          retryArmed = true;
          $('subtitleText').textContent = forScreen(t0.text);
          document.body.classList.add('no-speech');
        }
        render();
        return;
      }

      render();
      waitUntilSilent('录音没打开，点这里重试');
      const my = gen;
      setTimeout(() => {
        if (my !== gen) return;
        if (state.speechMode) return;                              // 已经在用手机语音
        if (!voice.paused || (voice.currentTime || 0) > 0.2) return;  // 其实在响
        if (voice.error && voice.error.code === 1) return;          // 被我们中止的
        const t = currentTrack();
        if (t && t.audio) fallbackSpeak(t, my);                     // 真的没声音 → 换手机语音
      }, 600);
    });
    /* 每 ~250ms 更新一次时间；只改两个文本节点，不重绘整页 */
    voice.addEventListener('timeupdate', onTime);
    voice.addEventListener('loadedmetadata', onTime);
    voice.addEventListener('seeked', onTime);

    voice.addEventListener('waiting', () => document.body.classList.add('buffering'));
    voice.addEventListener('canplay', () => document.body.classList.remove('buffering'));

    const net = () => {
      $('netChip').dataset.on = navigator.onLine ? '1' : '0';
      updateOfflineNotice();
      if (navigator.onLine && cacheState === 'failed') startOfflineCache();
      if (drawerOpen) renderDrawer();
    };
    window.addEventListener('online', net);
    window.addEventListener('offline', net);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && wantPlay && voice.paused && !state.playing) safePlay(gen);
    });
  }

  /* ============================================================ 10. 启动 */
  function boot() {
    /* 拿不到内容时，分两种情况给出「照着做就能好」的提示。 */
    if (!SPOTS.length) {
      const isFile = location.protocol === 'file:';
      const hasFile = (function () {
        try { return typeof TOUR === 'object' && TOUR !== null; } catch (e) { return false; }
      })();
      /* 诊断信息：出问题时能让用户一句话说清「卡在哪一步」 */
      const loc = (typeof location !== 'undefined' && location) || {};
      const page = String(loc.pathname || loc.href || '').split('/').pop() || '(未知)';
      const diag = '协议=' + (loc.protocol || '未知') +
                   ' ｜ window.TOUR=' + (window.TOUR ? '有' : '无') +
                   ' ｜ data.js变量=' + (hasFile ? '在' : '没执行') +
                   ' ｜ 文件=' + page;

      const box = document.createElement('div');
      box.className = 'fatal';
      box.innerHTML =
        (isFile
          ? '<b>请用网址打开，不要直接双击文件</b>' +
            '<span>双击打开时，浏览器会拦掉本地的 data.js，所以讲解内容读不到。</span>' +
            '<span>在这个文件夹里运行：</span>' +
            '<code>python3 -m http.server 8080</code>' +
            '<span>然后打开 http://localhost:8080</span>' +
            '<span>（正式使用请按 README 部署到 GitHub Pages，手机扫码即用。）</span>'
          : '<b>讲解内容没加载出来</b>' +
            '<span>多半是 data.js 没能加载或被执行时出错。</span>' +
            '<span>在项目目录运行 <code>node tools/verify.js</code>，它会指出具体问题。</span>' +
            '<span>如果刚改过文件，先在浏览器里强制刷新一次（电脑 ⌘/Ctrl + Shift + R）。</span>') +
        '<em class="diag">' + diag + '</em>';
      document.body.appendChild(box);
      if (!isFile) speak('讲解内容没加载出来，请检查一下 data.js。');
      return;
    }

    render();
    bind();
    $('stage').inert = true;
    setTimeout(() => $('startBtn').focus(), 0);
    $('netChip').dataset.on = navigator.onLine ? '1' : '0';
    updateOfflineNotice();
    $('sparkles').innerHTML = '<i>✨</i><i>⭐</i><i>✨</i>';

    /* 欢迎页每次都显示：iOS 上「没有用户手势就调 play()」会被拒绝，
       让用户（或孩子）点一次「开始听」是最稳的做法，也能避免"点了没反应"。 */
    play(false);                        // 预载第一段（只加载，不出声）

    /* Service Worker：离线能力 */
    if (navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function' &&
        location.protocol.indexOf('http') === 0) {
      navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready)
        .then(() => startOfflineCache())
        .catch(() => {
          cacheState = 'failed';
          if (drawerOpen) renderDrawer();
        });
      if (typeof navigator.serviceWorker.addEventListener === 'function') {
        navigator.serviceWorker.addEventListener('message', (ev) => {
          if (!ev.data) return;
          if (ev.data.type === 'cache-progress') {
            cacheState = 'loading';
            cacheDone = ev.data.done || 0;
            cacheTotal = ev.data.total || 0;
          } else if (ev.data.type === 'cache-ready') {
            cacheState = 'ready';
            cacheDone = cacheTotal = ev.data.total || cacheTotal;
            $('netChip').dataset.cached = '1';
          } else if (ev.data.type === 'cache-incomplete') {
            cacheState = 'failed';
            $('netChip').dataset.cached = '0';
          }
          updateOfflineNotice();
          if (drawerOpen) renderDrawer();
        });
      }
    }
  }

  function offlineAssets() {
    const assets = [];
    SPOTS.forEach((spot) => {
      assets.push('images/' + spot.id + '-v2.webp');
      tracksOf(spot).forEach((track) => (track.audio || []).forEach((src) => assets.push(src)));
    });
    return Array.from(new Set(assets));
  }

  function startOfflineCache() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.ready) return;
    cacheState = 'loading';
    cacheDone = 0;
    cacheTotal = offlineAssets().length;
    $('netChip').dataset.cached = '0';
    if (drawerOpen) renderDrawer();
    navigator.serviceWorker.ready.then((reg) => {
      if (reg.active) reg.active.postMessage({ type: 'cache-all', assets: offlineAssets() });
    }).catch(() => {
      cacheState = 'failed';
      if (drawerOpen) renderDrawer();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
