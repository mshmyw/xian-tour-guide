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
  /* 进度条元素：render() 里要用（必须在 boot 之前声明，避免暂时性死区） */
  const seekEl = $('seek');

  const voice = $('voice');
  /* 进度存储键：段落结构一变就要换名（旧进度与新音频不可比），所以集中写一处 */
  const DONE_KEY = 'qin-done-v2';
  const done = new Set(store.get(DONE_KEY, []));          // 「地点id:段号」已听完

  const state = {
    spot: 0,
    track: 0,
    playing: false,
    unlocked: false,
    silentChecked: false,
    finished: false
  };

  /* ============================================================ 2. 数据存取 */
  /* 每个地点只有一段（合并后），保留数组是为了以后想再拆分时不用改这里 */
  const tracksOf = (spot) => spot.tracks;
  const currentSpot = () => SPOTS[state.spot];
  const currentTrack = () => tracksOf(currentSpot())[state.track];
  const keyOf = (si, ti) => SPOTS[si].id + ':' + ti;
  const currentKey = () => keyOf(state.spot, state.track);
  const spotDone = (i) => tracksOf(SPOTS[i]).every((_, n) => done.has(keyOf(i, n)));
  const totalTracks = () => SPOTS.reduce((n, s) => n + tracksOf(s).length, 0);
  /* 全部内容的时长之和（秒）。用于告诉家人"这一趟大概要听多久"。 */
  const totalSeconds = () => SPOTS.reduce((n, sp) =>
    n + tracksOf(sp).reduce((m, t) => m + (t.dur || 0), 0), 0);
  const totalMinutes = () => Math.round(totalSeconds() / 60);

  /* 清空"已听完"进度：孩子想再走一遍、或进度被弄脏时用 */
  function resetProgress() {
    done.clear();
    try { localStorage.removeItem(DONE_KEY); } catch (e) {}
    store.set(DONE_KEY, []);
    state.track = 0;
    render();
    if (drawerOpen) renderDrawer();
  }

  function markDone() {
    const k = currentKey();
    if (done.has(k)) return false;              // 已经记过，不重复持久化
    done.add(k);
    store.set(DONE_KEY, Array.from(done));
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
  let cacheState = 'waiting';
  let cacheDone = 0;
  let cacheTotal = 0;

  /* 给 play() 加超时，但不留下"输了比赛还继续跑的定时器"：
     Promise.race 的那个 setTimeout 不会被清掉，会在 5 秒后空转一次、还可能
     把一个已经 settle 的 Promise 再 reject 一遍。 */
  const playWithTimeout = (el, ms) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const e = new Error('play timeout'); e.name = 'TimeoutError'; reject(e);
    }, ms || 5000);
    el.play().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });

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
      if (!voice.paused || (voice.currentTime || 0) > 0.2) return;   // 在响或在走
      if (!expectSrc) return;                      // 当前这一段没有录音
      if (voice.getAttribute('data-src') !== expectSrc) return;      // 已经切到别的段了
      if (voice.error && voice.error.code === 1) return;             // 只是被我们中止的
      const t = currentTrack();
      if (t) showTextOnly(t, reason); else flagAudioFail(true, reason);
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
    /* 清掉上一次"放不出声音"留下的常显字幕状态（no-speech 只在失败期间该存在） */
    document.body.classList.remove('no-speech');
    state.finished = false;          // 又开始播了，"讲完了"的提示收起来
    wantPlay = playNow !== false;
    playingKey = null;

    try { voice.pause(); } catch (e) {}
    state.playing = false;

    const src = (track.audio || [])[0];
    expectSrc = src || null;
    if (!src) {
      /* 数据里这一段落没配录音（正常不会发生）：直接把文字铺出来 */
      expectSrc = null;
      showTextOnly(track);
      return;
    }

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
    }
  }

  /* 屏幕上显示的文字：去掉尖括号里"只念不显示"的内容（如手机号）。 */
  const forScreen = (t) => String(t || '').replace(/<[^>]*>/g, '');

  /* 一站讲完后，屏幕上**不再给任何引导文案**（原来这里有一句
     `✅ 点 ▶ 去一号坑`）。理由：
       · 状态已经说明白了：声音停了、星星撒了、中间大按钮从 Ⅱ 变回 ▶、
         提示回到中性的「👂 听故事」，右侧箭头还会轻晃两下；
       · 下一站叫什么，录音结尾的转场句本来就会念（"看完后，我们去三号坑"）；
       · 最关键的一条：当初取消"播完自动跳下一站"，理由就是"人得先挪到下一个坑，
         被拽着跑很难受"。屏幕上再挂一句 CTA + 一个一直晃的箭头，等于把自动跳
         换成了视觉版的拽人。景区里该看的是坑，不是手机。
     所以这句话是整个删掉的，不是缩短 —— 别再往回加。 */

  /* 录音打不开（或这一段没配录音）：红框说明原因 + 把整段文字铺在屏幕上，
     点一下播放键就能重试。没有"换手机语音接着念"这条兜底——全部内容都是 mp3。 */
  function showTextOnly(track, reason) {
    state.playing = false;
    flagAudioFail(true, reason || '这段录音没打开，我把文字显示出来');
    retryArmed = true;
    document.body.classList.add('no-speech');
    render();                                    // 先渲染，再把字幕换成整段文字
    const box = $('subtitleText');
    if (box) box.textContent = forScreen(track.text);
  }

  /* 停住声音 + 让所有在途的播放回调作废：gen 一变，旧回调比对不过就自己退出。
     「用户暂停」和「换地点前先停住」共用这一段，免得两处各写一遍、改一处漏一处。 */
  function stopAudio() {
    gen++;
    clearTimeout(silentTimer);
    try { voice.pause(); } catch (e) {}
    state.playing = false;
    playingKey = null;
  }

  function pause() {
    stopAudio();
    wantPlay = false;
    releaseWake();
    render();
  }

  function toggle() {
    unlock();
    if (state.playing) { pause(); return; }
    if (retryArmed) { retryArmed = false; play(true); return; }   // 点一下直接重试
    /* 讲完之后点这里 = 从头再讲一遍本站。
       这是播放键该有的语义（▶ = 再放一遍），不要改成"跳下一站"：
       要往下走有右侧 ▶ 箭头和滑动（换地点那套操作），两件事分开才讲得清。
       走到下一个坑的人点它，听到的是刚才那一站 —— 那正是他要的"再听一遍"。 */
    if (voice.getAttribute('data-src') && voice.currentTime > 0 && !voice.ended) {
      safePlay(gen);
      return;
    }
    play(true);
  }

  /* 一段结束 → 自动下一段（调用方已校验归属） */
  /* 一站讲完就停下，**不自动播下一站**。
     现场是要走路的：这站听完，人得先挪到下一处，再决定什么时候听。
     自动跳过去会把人拽着跑（"我还没看完呢，怎么已经讲到下一个坑了"）。
     所以这里只把"讲完了"标出来，切换交给用户：右侧 ▶ 箭头 / 滑动换地点；
     中间大按钮则留在"再讲一遍本站"的播放键语义上。 */
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
    state.finished = true;
    /* 这里必须把 wantPlay 清掉。不清的话，讲完后再切回前台时，
       visibilitychange 那个分支会以为"还想播"，于是把刚讲完的这一整段
       从头再放一遍（锁屏解锁就会触发，一段三分多钟）。
       讲完 = 我们不打算接着播，等用户点按钮。 */
    wantPlay = false;
    render();
    celebrate();
  }

  /* ============================================================ 4. 切换 */
  /* 换地点/跳到某站前先停住（wantPlay 不在这里清：紧接着的 play() 会按新目标设好） */

  function changeSpot(next, autoplay) {
    next = Math.max(0, Math.min(SPOTS.length - 1, next));
    if (next === state.spot) return;
    stopAudio();
    state.spot = next;
    state.track = 0;
    state.finished = false;
    closeDrawer();
    render();
    if (autoplay !== false) play(true);
  }

  function jumpTo(si, ti) {
    stopAudio();
    state.spot = si;
    state.track = ti || 0;
    closeDrawer();
    render();
    play(true);
  }

  /* 秒 → m:ss */
  const fmt = (sec) => {
    if (!isFinite(sec) || sec < 0) sec = 0;
    sec = Math.round(sec);
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  };

  /* 播放进度：左边"第几段/共几段"（单段地点不显示，见 onTime），右边"已播/总长"。
     时长优先用音频真实时长，元数据还没加载完时回退到 data.js 里的 dur 估算。 */
  function seekTotalSeconds() {
    const d = voice.duration;
    const item = currentTrack();
    if (isFinite(d) && d > 0) return d;
    return (item && item.dur) || 0;
  }

  function onTime() {
    const spot = currentSpot();
    const data = currentTrack();          // 本文件里这个函数就叫 currentTrack
    if (!data || !spot) return;
    const tracks = tracksOf(spot);

    /* 一个地点只有一段时，"第 1/1 段"是废话，直接不显示。
       这一段也是「以后想再拆分」时唯一会被点亮的显示位
       （数据模型与 app.js 都保留了多段能力，只是抽屉里没有选段入口）。 */
    $('pIndex').textContent = tracks.length > 1
      ? '第 ' + (state.track + 1) + '/' + tracks.length + ' 段' : '';

    const total = seekTotalSeconds();
    const cur = voice.currentTime || 0;
    $('pTime').textContent = fmt(cur) + ' / ' + fmt(total);
    if (!state.seeking) $('seek').value = total > 0 ? String(Math.round(cur / total * 1000)) : '0';
    updateSubtitle(cur, total);
  }

  /* 录音没有逐句时间轴，按句子长度在真实时长上分配，保证字幕短、大、易读。 */
  function subtitleParts(text) {
    const clean = String(text || '').replace(/\s+/g, '').trim();
    if (!clean) return [];
    return clean.match(/[^\u3002！？；!?;]+[\u3002！？；!?;]?/g) || [clean];
  }

  /* --------- 字幕时间轴估算 ---------
     两个曾经让字幕"跑在录音前头"的原因，都在下面这两步里修掉：

     ① 录音的开头是**标题**（make_audio_node.js 会把 data.js 的 title 念一遍），
        而屏幕上的 text 里没有这句。不把它算进时间轴，整段字幕就会平均提前
        一个标题的时长；短段最明显（出发前 11 秒里有 1 秒多，等于第一句还没念完
        字幕已经翻页）。
     ② 标点也要占时间。原来看的是"去掉标点后的字数"，于是一串长句被压低、
        一串短句被抬高，误差逐段累积。句末的停顿比逗号长，权重给得更高。

     权重 = 字数 + 标点停顿（句号 1.5 字、逗号 0.35 字），前几步再加一点
     起播垫音。这个系数是拿现成的 mp3 对出来的（全 9 段误差都在 1 秒左右），
     不是拍脑袋定的；要动就重新对着 mp3 核一遍。 */
  const HEAD_OVERHEAD = 0.6;               // 录音最前面的起播垫音（秒）

  /* 与 tools/make_audio_node.js 的 speakable() 对齐：标题在正文里出现过就不再单独念。
     不一致的话字幕会整体偏一段，所以这两处要一起改。 */
  function speakable(s) {
    return String(s || '')
      .replace(/[<>「」“”"]/g, '')
      .replace(/[（(]/g, '，').replace(/[）)]/g, '，')
      .replace(/——/g, '，').replace(/…+/g, '，')
      .replace(/《》/g, '');
  }

  /* 一句话的朗读时长估算：字算 1，标点算停顿，句末标点再补一点拖音费用 */
  function speechWeight(s) {
    const t = String(s || '');
    const marks = t.match(/[\u3002！？；!?;，,：:、]/g) || [];
    const lastMark = (t.match(/[\u3002！？；!?;]\s*$/) || [])[0];
    return t.replace(/[\s\u3002！？；!?;，,：:、]/g, '').length +
      marks.length * 0.35 + (lastMark ? 1.5 : 0);
  }

  /* 切句只在「当前是哪一段」变化时重算一次：
     timeupdate 每秒来 4 次，每次都对着 600~700 字重跑一遍正则 + 建数组，
     老人机上没必要。 */
  let subtitleCache = null;
  function subtitleLayout() {
    const key = state.spot + ':' + state.track;
    if (subtitleCache && subtitleCache.key === key) return subtitleCache;
    const track = currentTrack() || {};
    const parts = subtitleParts(track.text);
    const weights = parts.map(speechWeight);
    const body = speakable(track.text);
    const title = speakable(track.title);
    /* 标题被念过、但正文里没有它 —— 这段时间也要算进分母，字幕才不会被拽着往前跑 */
    const titleSec = (title && body.indexOf(title) < 0) ? title.length * 0.25 : 0;
    const sum = weights.reduce((n, v) => n + v, 0) + titleSec + HEAD_OVERHEAD;
    subtitleCache = { key, parts, weights, sum };
    return subtitleCache;
  }

  function updateSubtitle(cur, total) {
    const cache = subtitleLayout();
    const parts = cache.parts, weights = cache.weights, sum = cache.sum;
    if (!parts.length) { $('subtitleText').textContent = ''; return; }
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

    $('scene').style.backgroundImage = 'url("images/' + spot.id + '-v2.webp")';

    $('placeName').textContent = spot.name;
    $('placeIcon').textContent = spot.emoji || '🏺';
    /* 提示只有两个中性状态，没有"讲完了 / 去下一站"这类引导（见上方说明）。
       右箭头轻晃两下由 body.ready-next 负责，那是一次性的，不无限晃。 */
    $('placeHint').textContent = state.playing ? '🔊 正在讲' : '👂 听故事';
    document.body.classList.toggle('ready-next', !state.playing && state.finished);

    $('prevBtn').disabled = state.spot === 0;
    $('nextBtn').disabled = state.spot === SPOTS.length - 1;
    document.body.classList.toggle('playing', state.playing);
    $('mainPlay').setAttribute('aria-label', state.playing ? '暂停' : '播放');
    $('scenePlay').setAttribute('aria-label', state.playing ? '暂停' : '播放');
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
  /* 进度导览：把 9 站画成一条路线带。
     节点状态：灰（没去过）→ 点亮打勾（去过）→ 金圈（现在这一站）。
     每个节点可点，直接跳到那一站。 */
  function renderTourMap() {
    const el = $('tourMap');
    if (!el) return;
    let track = '';
    SPOTS.forEach((sp, i) => {
      const here = i === state.spot;
      const got = spotDone(i);
      if (i) track += '<span class="tm-link' + (spotDone(i - 1) ? ' on' : '') + '"></span>';
      track += '<button class="tm-node' + (here ? ' now' : '') + (got ? ' visited' : '') +
        '" data-jump="' + i + '" data-track="0" title="' + sp.name + '"' +
        ' aria-label="' + sp.name + (got ? '（已参观）' : '') + (here ? '，当前所在' : '') + '">' +
        '<span aria-hidden="true">' + (sp.emoji || '📍') + '</span></button>';
    });

    /* 只画路线本身：节点状态（灰/绿/金圈）已经说明一切。
       不要再往上加文字进度——和图形表达同一件事，还容易口径不一致。 */
    el.innerHTML = '<div class="tm-track">' + track + '</div>';
  }

  function renderDrawer() {
    renderTourMap();
    const phaseName = {};
    (TOUR.phases || []).forEach((p) => { phaseName[p.id] = p.emoji + ' ' + p.name; });

    /* 每个地点只有一段，所以整张卡就是一个按钮：图标 + 地名 + 这段的标题。
       不再套一层"第几段"——编号和"点哪一段"的层级都没有意义了。 */
    const items = SPOTS.map((s, i) => {
      const here = i === state.spot;
      const finished = spotDone(i);
      /* 卡片右侧只标"当前所在"（▶）。
         "是否参观过"由顶部路线带表达（绿圈/灰圈），这里再放一个 ✅ 是同一状态画两遍。 */
      const mark = here ? '▶' : '';
      const t = tracksOf(s)[0] || {};
      return { phase: s.phase || '', html:
        '<button class="d-item' + (here ? ' active' : '') + (finished ? ' finished' : '') +
          '" data-jump="' + i + '">' +
          '<span class="d-emoji" aria-hidden="true">' + (s.emoji || '📍') + '</span>' +
          '<span class="d-text">' +
            '<span class="d-name">' + s.name + '</span>' +
            (t.title ? '<span class="d-sub">' + t.title + '</span>' : '') +
          '</span>' +
          '<span class="d-mark" aria-hidden="true">' + mark + '</span>' +
        '</button>' };
    });

    /* 同一阶段的放在一起。只有一站的小组不加小标题 ——
       否则「🎒 出发前」会在小标题和卡片上连着重复两次。 */
    const phaseSize = {};
    items.forEach((it) => { phaseSize[it.phase] = (phaseSize[it.phase] || 0) + 1; });
    let html = '', lastPhase = null;
    items.forEach((it) => {
      if (it.phase !== lastPhase) {
        lastPhase = it.phase;
        if (it.phase && phaseSize[it.phase] > 1) {
          html += '<p class="d-phase">' + (phaseName[it.phase] || it.phase) + '</p>';
        }
      }
      html += it.html;
    });
    $('drawerList').innerHTML = html;

    $('drawerNet').textContent = cacheStatusText();
    $('cacheBtn').hidden = cacheState !== 'failed' || !navigator.onLine;
  }

  /* 一次性文字确认：借用欢迎卡的状态行位置（欢迎页此时通常已关闭，就退化成短暂提示） */
  let flashTimer = null;
  function flashDrawerHint(text) {
    const el = $('drawerNet');
    if (!el) return;
    el.textContent = text;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { if (drawerOpen) renderDrawer(); }, 4000);
  }

  /* 离线状态文案：抽屉底部和欢迎卡共用同一份，避免两处说法不一致 */
  function cacheStatusText() {
    if ($('netChip').dataset.cached === '1') return '✅ 已下载完，没信号也能听';
    if (!navigator.onLine) return '⚠️ 当前离线，有些内容可能还没下载';
    if (cacheState === 'failed') return '⚠️ 离线内容没下完，请重试';
    if (cacheTotal) return '⏳ 正在下载 ' + cacheDone + '/' + cacheTotal + '，先别断网';
    return '⏳ 正在准备离线内容…';
  }

  function updateOfflineNotice() {
    const wn = $('welcomeNet');
    if (wn) wn.textContent = cacheStatusText();
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

  let mediaKey = null;                     // 上一次设过锁屏元数据的「地点/段」
  function mediaSession(track, spot) {
    if (!('mediaSession' in navigator) || !track || !spot) return;
    /* safePlay() 和 audio 的 playing 事件都会调到这里（同一次播放两次）。
       同一段只设一次元数据即可 —— 下面这些 action handler 是闭包，
       取的永远是"当前段"，不需要跟着段变重设。 */
    const key = spot.id + '/' + (track.id || '');
    if (key === mediaKey) return;
    mediaKey = key;
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
    /* 引导卡：**整张卡任意位置**都能开始，不要求点中按钮。
       老人和小孩不会瞄准按钮，点哪儿都该有反应。 */
    let started = false;
    const startTour = () => {
      if (started) return;            // 防止卡片和按钮各触发一次
      started = true;
      unlock();                       // 内部会把 state.unlocked 置为 true（必须在 play 之前）
      state.unlocked = true;
      $('welcome').hidden = true;
      $('stage').inert = false;
      play(true);
    };
    $('welcome').addEventListener('click', startTour);
    $('startBtn').addEventListener('click', startTour);     // 按钮也监听：无障碍和键盘更稳
    $('welcome').addEventListener('touchend', (e) => { e.preventDefault(); startTour(); }, { passive: false });

    /* 抽屉 */
    $('drawerBtn').addEventListener('click', () => { drawerOpen ? closeDrawer() : openDrawer(); });
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerMask').addEventListener('click', closeDrawer);
    $('cacheBtn').addEventListener('click', startOfflineCache);
    /* 清空进度要确认一下，避免老人误触把贴纸册清掉 */
    $('resetBtn').addEventListener('click', () => {
      if (!done.size) { $('drawerNet').textContent = '还没有听过任何一段'; return; }
      if (window.confirm('清空"已听完"的记录，从头再走一遍？')) resetProgress();
    });
    /* 绑在抽屉整体上：地点列表和顶部路线带的节点都能点 */
    $('drawer').addEventListener('click', (e) => {
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

    /* 键盘只用这一个监听：欢迎页与主界面共用（见下方分支）。
       以前分成两个监听会出问题 —— 同一次空格先 startTour()→play(true)，
       第二个监听紧接着又 toggle()，把第一段白载两遍。
       欢迎页还开着时方向键什么都不做：以前会在卡片背后偷偷换站，
       而且没有用户手势就调 play()，iOS 会直接拒绝。
       方向键补上 unlock()，和左侧 ◀ ▶ 按钮的行为对齐（以前只有按钮解锁，键盘不出声）。 */
    document.addEventListener('keydown', (e) => {
      if (!$('welcome').hidden) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); startTour(); }
        return;
      }
      if (e.key === 'ArrowRight') { unlock(); changeSpot(state.spot + 1, true); }
      else if (e.key === 'ArrowLeft') { unlock(); changeSpot(state.spot - 1, true); }
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
      /* 真滑动：先掐掉浏览器随后补发的那次 click。
         不掐的话，覆盖整屏的 #scenePlay 会再收到一次 toggle() ——
         play() 是异步的，这一次 click 要么把刚起来的声音暂停掉，
         要么让同一段 mp3 被 src+load() 载两遍（弱网下既费流量，又可能误报"没放出来"）。
         只有滑动才 preventDefault，轻点照旧交给按钮的 click。 */
      if (typeof e.preventDefault === 'function') e.preventDefault();
      changeSpot(state.spot + (dx < 0 ? 1 : -1), true);
    }, { passive: false });

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
      /* 只有"我们确实播放过、且播放的正是当前这一段"才算听完。
         不能像以前那样放行 playingKey 为空的情况——那会把没播过的段落也记成已听。 */
      const key = currentKey();
      const track = currentTrack();
      if (!key || !track) return;
      if (!(track.audio || []).length) return;      // 没有录音的段落不走 audio 路径
      if (playingKey !== key) return;               // 不是这一段（含 playingKey 为空的误触发）
      if (voice.duration && isFinite(voice.duration) && voice.currentTime < voice.duration - 0.35) return;
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

      render();
      /* 不立刻弹红框：先观察 2.5 秒，避免把"切换音频瞬间的 error"误报成失败 */
      waitUntilSilent('这段录音没打开，点这里重试');
    });
    /* 每 ~250ms 更新一次时间；只改两个文本节点，不重绘整页 */
    voice.addEventListener('timeupdate', onTime);
    voice.addEventListener('loadedmetadata', onTime);
    voice.addEventListener('seeked', onTime);

    /* 拖动进度条跳转。要点：
       ① 拖动过程中暂停 timeupdate 覆盖，否则滑块会被"弹回去"；
       ② 松手后如果原来在播，就继续播。 */
    const seekStart = () => {
      state.seeking = true;
      state.seekWasPlaying = state.playing;
      /* iOS 提醒：拖动中如果音频继续跑，指头和声音会对不上，先停住再说 */
      try { voice.pause(); } catch (e) {}
    };
    const seekMove = () => {
      if (!state.seeking) return;
      const total = seekTotalSeconds();
      if (total > 0) {
        $('pTime').textContent = fmt(total * (+seekEl.value / 1000)) + ' / ' + fmt(total);
      }
    };
    const seekEnd = () => {
      if (!state.seeking) return;
      state.seeking = false;
      const total = seekTotalSeconds();
      if (total > 0) {
        try { voice.currentTime = total * (+seekEl.value / 1000); } catch (e) {}
      }
      /* 松手后按原状态继续：原来在播就接着播，原来暂停就停在拖到的位置 */
      if (state.seekWasPlaying) safePlay(gen);
      else { state.playing = false; render(); }
    };
    seekEl.addEventListener('pointerdown', seekStart);
    seekEl.addEventListener('mousedown', seekStart);
    seekEl.addEventListener('touchstart', seekStart, { passive: true });
    seekEl.addEventListener('input', seekMove);
    seekEl.addEventListener('change', seekMove);
    /* 关键：松手要绑在 document 上。
       绑在滑块上时，手指滑出滑块范围后 pointerup 不会在滑块上触发，
       seekEnd 就永远不执行 —— 表现就是"松手后又弹回原来的进度"。 */
    document.addEventListener('pointerup', seekEnd);
    document.addEventListener('pointercancel', seekEnd);
    document.addEventListener('mouseup', seekEnd);
    document.addEventListener('touchend', seekEnd);
    document.addEventListener('touchcancel', seekEnd);

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
      /* 诊断信息：出问题时能让用户一句话说清「卡在哪一步」。
         注意不要再拿 TOUR 判断「data.js 有没有执行」—— TOUR 上面已经被 `|| {}`
         兜过底，那个判断恒为真，"data.js变量=在" 在任何故障下都成立，等于没写。
         现在如实报两个数：脚本有没有跑（window.TOUR）、跑出来几处地点。 */
      const loc = (typeof location !== 'undefined' && location) || {};
      const page = String(loc.pathname || loc.href || '').split('/').pop() || '(未知)';
      const spotCount = (function () {
        try { return ((window.TOUR && window.TOUR.spots) || []).length; } catch (e) { return '?'; }
      })();
      const diag = '协议=' + (loc.protocol || '未知') +
                   ' ｜ window.TOUR=' + (window.TOUR ? '有' : '无') +
                   ' ｜ 地点数=' + spotCount +
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
      return;
    }

    render();
    bind();
    $('stage').inert = true;
    setTimeout(() => $('startBtn').focus(), 0);
    $('netChip').dataset.on = navigator.onLine ? '1' : '0';
    updateOfflineNotice();
    $('sparkles').innerHTML = '<i>✨</i><i>⭐</i><i>✨</i>';

    /* 把总时长告诉用户：欢迎卡上写"全程约 N 分钟"，抽屉里也标一份 */
    const mins = totalMinutes();
    $('welcomeTotal').textContent = '全程约 ' + mins + ' 分钟 · 共 ' + totalTracks() + ' 段';
    $('drawerTotal').textContent = '全程约 ' + mins + ' 分钟';

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
            if ($('netChip').dataset.cached !== '1') flashDrawerHint('离线内容已备好，没信号也能听');
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
