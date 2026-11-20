// 影像解剖图谱·查看器：翻层 + 双指缩放 + 轮廓叠加 + 点选显示结构名
// 数据约定：
//   meta.json    {z, w, h, structures: [{id, name_en, name_zh, color}]}
//   contours.json {"slices": {"层号": [{s: 结构id, p: [归一化扁平点列 [x1,y1,...]]}]}}

let meta = null;          // 病例元数据
let slices = {};          // 轮廓数据（按层）
let current = -1;         // 当前【已显示】的层号（-1 = 还没有任何一层加载完成）
let scale = 1;            // 缩放倍数
let pinching = false;     // 是否正在双指缩放
let selectedSid = null;   // 当前选中的结构 id（点选后保持，翻层跟随）

// ---- 图层同步与预取状态（核心：图像和轮廓必须同帧切换）----
// 老逻辑在 show() 里立刻重画新层轮廓，但 <img> 换 src 是异步的：
// 网络没回来前浏览器仍显示上一层老图 → 「新层的框套在旧层的图上」。
// 现在只有目标层真正解码完成后才同时换图 + 画框；等待期间旧图旧框整体不动。
let pendingK = 0;              // 用户最后请求的层（滑块/手势的目标层）
let direction = 1;             // 最近一次翻层方向，用于决定预取侧重
const imgCache = new Map();    // 层号 → 已解码的 Image（LRU，来回滑动不重复解码）
const pendingLoads = new Map();// 层号 → 正在加载的 Promise（合并重复请求）
const IMG_CACHE_MAX = 16;      // 内存最多保留 16 张已解码切片（512² 约 16MB）
const PREFETCH_AHEAD = 8;      // 沿滑动方向预取 8 层
const PREFETCH_BEHIND = 4;     // 反方向预取 4 层
let pendingTimer = null;       // 快速滑动时合并加载请求的定时器

const stage = document.getElementById('stage');
const viewport = document.getElementById('viewport');
const sliceEl = document.getElementById('slice');
const overlayEl = document.getElementById('overlay');
const slider = document.getElementById('slider');
const label = document.getElementById('label');
const tagEl = document.getElementById('tag');
const btnInfo = document.getElementById('btn-info');
const infoBackdrop = document.getElementById('info-backdrop');
const infoBody = document.getElementById('info-body');
const btnInfoClose = document.getElementById('btn-info-close');
const labelsEl = document.getElementById('labels');
const btnLabels = document.getElementById('btn-labels');
let infoData = null;      // 病例信息 + 疾病科普（info.json）
let annotationsOn = true; // 总开关：轮廓和名称一起显示 / 一起消失
let namesOn = false;      // 结构太多时只画轮廓、不铺名称（避免糊成一团）
let sliceBase = 'slices/';// 切片基址：本地调试读相对目录，线上读香港服务器的 assets 子域

// ---------- 初始化 ----------
async function init() {
  meta = await fetch('meta.json').then(r => r.json());
  slices = (await fetch('contours.json').then(r => r.json())).slices;

  // 切片源：本地/内网调试走同目录 slices/（开发中的病例不必先上传服务器）；
  // 线上走 your-cdn.example.com —— Cloudflare Pages 单项目上限 2 万文件，
  // 1.8 万个切片已迁到香港服务器，Pages 只保留页面、轮廓和缩略图。
  // 公共演示版只读同目录 slices/，不内置任何线上地址
  sliceBase = 'slices/';

  slider.max = Math.max(0, meta.z - 1);
  // 单张图片病例（X 光 / 教学图 / 单层数据集）：翻不了层，隐藏控件并明确标注
  if (meta.z <= 1) {
    ['btn-prev', 'btn-next', 'slider'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    // 计数推到最右，避免和左下角的「返回病例库」按钮重叠
    const lab = document.getElementById('label');
    if (lab) lab.style.marginLeft = 'auto';
  }
  overlayEl.setAttribute('viewBox', `0 0 ${meta.w} ${meta.h}`);
  // 显示尺寸上限=原图 1.6 倍：防止电脑大屏把低分辨率切片拉糊；手机屏小于此值时仍自动填满
  sliceEl.style.width = `min(100vw, 100vh, ${Math.round(meta.w * 1.6)}px)`;
  // 初始层：优先打开封面层（meta.cover_k，内容最丰富的一层）；
  // 老数据没有 cover_k 时回退到中间层，避免一进来看到脖子/颅底这种"空层"。
  const start = Number.isInteger(meta.cover_k) ? meta.cover_k : Math.floor((meta.z - 1) / 2);
  // 结构少（≤40）默认直接显示引线标注；精细图谱（69/116 区）默认关闭，避免糊成一团
  const nStruct = (meta.structures || []).length;
  const hasContours = Object.keys(slices).length > 0;
  // 名称只在结构数量不太多时铺开；69/116 区精细图谱默认只画轮廓，点选仍可看名称
  namesOn = nStruct > 0 && nStruct <= 40;
  // 完全没有轮廓的病例（如 Radiopaedia 单图），总开关没有意义，隐藏
  if (!hasContours) btnLabels.style.display = 'none';
  updateLabelsButton();
  initRoi();     // 先建 ROI 图层/按钮，present() 里才能安全刷新
  initMeasure(); // 长度 / 角度测量（与 ROI 互斥）
  initMarks();   // 收藏 / 最近访问 / 病例笔记（纯本地存储）
  show(start);

  // 病例信息面板：info.json 不存在时隐藏按钮（老成品仍可正常查看影像）
  loadInfo();
}

// ---------- 病例信息 / 疾病科普 ----------
async function loadInfo() {
  try {
    const res = await fetch('info.json');
    if (!res.ok) throw new Error('no info.json');
    infoData = await res.json();
  } catch (e) {
    infoData = null;
    btnInfo.style.display = 'none';
  }
}

// 小工具：创建元素并设置文本
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderInfo() {
  if (!infoData) return;
  infoBody.innerHTML = '';
  const isAtlas = infoData.category === '图谱';
  const headTitle = isAtlas ? '图谱信息' : '病例信息';
  document.getElementById('info-head-title').textContent = headTitle;

  // ---- 0) 结构化影像报告（从标注 mask 自动计算，客观数值）----
  if (infoData.report) {
    const secReport = el('div', 'info-sec');
    secReport.appendChild(el('h3', '', '影像报告'));
    const pre = el('div', '');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.fontSize = '13.5px';
    pre.style.lineHeight = '1.75';
    pre.textContent = infoData.report;
    secReport.appendChild(pre);
    infoBody.appendChild(secReport);
  }

  // ---- 1) 真实临床字段 ----
  const secClinical = el('div', 'info-sec');
  const hClinical = el('h3', '', headTitle);
  const c = infoData.clinical || {};
  if (c.source) hClinical.appendChild(el('span', 'info-src', c.source));
  secClinical.appendChild(hClinical);

  if (c.available) {
    if (c.note) secClinical.appendChild(el('div', 'info-note', c.note));
    for (const group of (c.groups || [])) {
      const g = el('div', 'info-group');
      g.appendChild(el('h4', '', group.title || ''));
      const dl = el('dl', 'info-dl');
      for (const f of (group.fields || [])) {
        dl.appendChild(el('dt', '', f.label));
        // 字段值是 URL 时渲染成可点击链接（Radiopaedia 等许可要求可点击署名）
        if (/^https?:\/\//.test(f.value || '')) {
          const dd = el('dd', '');
          const a = document.createElement('a');
          a.href = f.value;
          a.target = '_blank';
          a.rel = 'noopener';
          a.textContent = f.value;
          dd.appendChild(a);
          dl.appendChild(dd);
        } else {
          dl.appendChild(el('dd', '', f.value));
        }
      }
      g.appendChild(dl);
      secClinical.appendChild(g);
    }
  } else {
    secClinical.appendChild(el('div', 'info-note',
      c.message || '该数据集未提供患者级临床信息（仅影像与标签）。'));
  }

  // ---- 2) 疾病科普（保留实质内容，去掉免责声明）----
  const secKnow = el('div', 'info-sec');
  secKnow.appendChild(el('h3', '', isAtlas ? '图谱说明' : '疾病科普'));
  const k = infoData.knowledge || {};
  secKnow.appendChild(el('div', 'know-title', k.title || ''));
  for (const s of (k.sections || [])) {
    const line = el('div', 'know-sec');
    line.appendChild(el('strong', '', (s.h || '') + '：'));
    line.appendChild(document.createTextNode(s.p || ''));
    secKnow.appendChild(line);
  }

  infoBody.appendChild(secClinical);
  infoBody.appendChild(secKnow);

  // ---- 3) 延伸阅读（指南/共识 + 近 2 年论文；默认折叠）----
  const refs = infoData.references;
  if (refs && (refs.guideline || (refs.papers && refs.papers.length))) {
    const secRefs = el('div', 'info-sec');
    secRefs.appendChild(el('h3', '', '延伸阅读'));
    const det = el('details', 'refs');
    det.appendChild(el('summary', '', '指南/共识 + 近 2 年论文（点击展开）'));

    const refItem = (item, tag) => {
      const row = el('div', 'ref-item');
      const head = el('div', 'ref-head');
      head.appendChild(el('span', 'ref-badge', tag));
      const a = document.createElement('a');
      a.href = item.url || '#';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = item.title || '';
      head.appendChild(a);
      row.appendChild(head);
      row.appendChild(el('div', 'ref-meta',
        [item.journal, item.year].filter(Boolean).join(' · ')));
      if (item.takeaway) row.appendChild(el('div', 'ref-takeaway', item.takeaway));
      return row;
    };

    if (refs.guideline) det.appendChild(refItem(refs.guideline, '指南/共识'));
    for (const p of (refs.papers || [])) det.appendChild(refItem(p, '论文'));
    secRefs.appendChild(det);
    secRefs.appendChild(el('div', 'refs-note',
      '文献由 PubMed 检索 + AI 初筛，供延伸阅读，不替代指南；请核对原文。'));
    infoBody.appendChild(secRefs);
  }

  infoBody.scrollTop = 0;
}

function openInfo() {
  if (!infoData) return;
  renderInfo();
  infoBackdrop.classList.remove('hidden');
}

function closeInfo() {
  infoBackdrop.classList.add('hidden');
}

btnInfo.addEventListener('click', openInfo);
btnInfoClose.addEventListener('click', closeInfo);
infoBackdrop.addEventListener('click', (e) => {
  if (e.target === infoBackdrop) closeInfo();   // 点遮罩关闭
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeInfo();
});

// ---------- 图层加载：切片图像与轮廓的同步切换 ----------
function sliceUrl(k) {
  return `${sliceBase}${String(k).padStart(4, '0')}.webp`;
}

// 读取（或发起）某一层图像，返回 Promise<Image>；成功时已解码完成，可直接上屏
function loadSlice(k, priority) {
  const hit = imgCache.get(k);
  if (hit) { touchCache(k); return Promise.resolve(hit); }
  if (pendingLoads.has(k)) return pendingLoads.get(k);

  const p = new Promise((resolve, reject) => {
    const im = new Image();
    im.decoding = 'async';                 // 异步解码，避免切图时掉帧
    if (priority) im.fetchPriority = priority;
    im.onload = () => {
      // decode() 等浏览器解码完成后再交给上屏逻辑，防止「先画框、后出图」
      const done = () => { putCache(k, im); resolve(im); };
      if (im.decode) {
        // 部分浏览器在 onload 里调用 decode() 可能长期不返回；超时兜底直接上屏
        Promise.race([im.decode(), new Promise(r => setTimeout(r, 400))]).then(done, done);
      } else done();
    };
    im.onerror = () => {
      // 线上切片在 your-cdn.example.com 跨域，ROI 读像素要求 CORS 模式。
      // 万一服务端没给 Access-Control-Allow-Origin，带 crossOrigin 会直接加载失败，
      // 这里退一步：去掉 CORS 再试一次，保证影像本身至少能看（只是 ROI 不可用）。
      if (im.crossOrigin) {
        im.removeAttribute('crossorigin');
        im.src = sliceUrl(k);
        return;
      }
      reject(new Error(`切片加载失败：${k}`));
    };
    im.crossOrigin = 'anonymous';          // 允许 canvas 读取像素（ROI 测值需要）
    im.src = sliceUrl(k);
  }).finally(() => pendingLoads.delete(k));

  pendingLoads.set(k, p);
  return p;
}

// 刷新 LRU 顺序：最近用过的挪到队尾
function touchCache(k) {
  if (!imgCache.has(k)) return;
  const im = imgCache.get(k);
  imgCache.delete(k);
  imgCache.set(k, im);
}

// 写入缓存并淘汰：优先扔掉离当前层最远的，其次扔最旧的
function putCache(k, im) {
  imgCache.delete(k);
  imgCache.set(k, im);
  while (imgCache.size > IMG_CACHE_MAX) {
    let victim = null;
    for (const key of imgCache.keys()) {
      if (Math.abs(key - current) > 2) { victim = key; break; }
    }
    if (victim === null) victim = imgCache.keys().next().value;
    imgCache.delete(victim);
  }
}

// 真正上屏：图像已解码，在同一次任务里重画轮廓 → 浏览器同一帧合成，不会错位
function present(k, im) {
  // 换了层面，上一层画上去的测量就不再对应当前图像，自动清除
  if (k !== current && measurePoints.length) clearMeasure(true);
  current = k;
  sliceEl.src = im.src;
  drawContours(k);
  renderLabels(k);
  updateRoiLayer();          // ROI 框与数值跟着当前层刷新
  slider.value = k;
  label.textContent = meta.z <= 1 ? '单张图片' : `${k + 1} / ${meta.z}`;
  // 当前层上屏后再预取邻居，避免和当前层抢带宽
  setTimeout(() => { if (current === k) prefetchAround(k); }, 60);
}

// 预取相邻层：先同方向近邻、再反方向；低优先级，不挤占当前层
function prefetchAround(k) {
  const order = [];
  for (let i = 1; i <= PREFETCH_AHEAD; i++) order.push(k + direction * i);
  for (let i = 1; i <= PREFETCH_BEHIND; i++) order.push(k - direction * i);
  for (const j of order) {
    if (j >= 0 && j < meta.z && !imgCache.has(j) && !pendingLoads.has(j)) {
      loadSlice(j, 'low').catch(() => {});
    }
  }
}

// ---------- 显示某一层（同步切换的唯一入口） ----------
function show(k) {
  if (!meta) return;
  pendingK = Math.max(0, Math.min(meta.z - 1, k));
  if (pendingK !== current) direction = pendingK > current ? 1 : -1;

  // 滑块和计数跟手，让用户知道自己滑到哪；图像/轮廓仍等加载完成才一起切
  slider.value = pendingK;
  label.textContent = meta.z <= 1
    ? '单张图片'
    : (current < 0
        ? `加载中 ${pendingK + 1} / ${meta.z}`
        : (pendingK === current
            ? `${current + 1} / ${meta.z}`
            : `${current + 1} / ${meta.z} · 加载 ${pendingK + 1}`));

  if (pendingK === current) { prefetchAround(current); return; }

  // 命中内存缓存：直接同帧切换
  const hit = imgCache.get(pendingK);
  if (hit) { touchCache(pendingK); present(pendingK, hit); return; }

  // 快速连续滑动时合并请求：只加载最后停下的那一层
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const target = pendingK;
    loadSlice(target, 'high')
      .then(im => { if (pendingK === target) present(target, im); })
      .catch(() => {});
  }, 25);

  // 只在本层距离已显示层很近时立刻预取，防止快速滑动时海量请求
  if (Math.abs(pendingK - current) <= 2) prefetchAround(pendingK);
}

// ---------- 画轮廓（选中结构加粗高亮） ----------
function drawContours(k) {
  overlayEl.innerHTML = '';
  if (!annotationsOn) return;   // 关闭标注时只清空，不画任何结构框
  const list = slices[String(k)] || [];
  for (const item of list) {
    const st = meta.structures.find(s => s.id === item.s);
    const color = st ? st.color : '#ffffff';
    const isSel = item.s === selectedSid;
    for (const poly of item.p) {
      const pts = [];
      for (let i = 0; i < poly.length; i += 2) {
        pts.push(`${(poly[i] * meta.w).toFixed(1)},${(poly[i + 1] * meta.h).toFixed(1)}`);
      }
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      el.setAttribute('points', pts.join(' '));
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', color);
      // 选中：加粗 + 不透明；其余：细线半透明（避免 117 结构糊成一团）
      el.setAttribute('stroke-width', isSel ? '3' : '2');
      el.setAttribute('opacity', isSel ? '1' : '0.9');
      // 线宽不随 SVG 缩放：病例图动辄 4000px，viewBox 缩到手机屏后 1 单位≈0.1px，肉眼看不见
      el.setAttribute('vector-effect', 'non-scaling-stroke');
      overlayEl.appendChild(el);
    }
  }
}

// ---------- 结构名引线标注（经典图谱样式） ----------
function updateLabelsButton() {
  if (!btnLabels) return;
  btnLabels.classList.toggle('active', !!annotationsOn);
  btnLabels.textContent = annotationsOn ? '标注 ✓' : '标注';
}

function renderLabels(k) {
  if (!labelsEl) return;
  labelsEl.innerHTML = '';
  if (!annotationsOn || !namesOn) return;
  const list = slices[String(k)] || [];
  const items = [];
  for (const item of list) {
    const st = meta.structures.find(s => s.id === item.s);
    if (!st) continue;
    // 取该结构在本层面积最大的轮廓，用质心作为引线起点
    let bestPoly = null, bestArea = -1;
    for (const poly of item.p) {
      const a = polyArea(poly);
      if (a > bestArea) { bestArea = a; bestPoly = poly; }
    }
    if (!bestPoly) continue;
    let sx = 0, sy = 0;
    const n = bestPoly.length / 2;
    for (let i = 0; i < bestPoly.length; i += 2) { sx += bestPoly[i]; sy += bestPoly[i + 1]; }
    items.push({
      sid: item.s, name: st.name_zh || st.name_en, color: st.color,
      x: sx / n, y: sy / n, area: bestArea,
    });
  }
  // 本层结构太多时只标面积最大的，避免文字糊满屏幕
  const maxLabels = meta.structures.length > 40 ? 26 : 40;
  items.sort((a, b) => b.area - a.area);
  const shown = items.slice(0, maxLabels);

  const left = [], right = [];
  for (const it of shown) (it.x < 0.5 ? left : right).push(it);

  // 垂直最小间距（归一化）：512 层图约 15px
  const gap = Math.max(0.022, Math.min(0.05, 15 / meta.h));
  // 结构少时字号大一点，结构多时缩小避免挤爆
  const fontSize = shown.length <= 12 ? 12.5 : (shown.length <= 24 ? 11.5 : 10.5);
  layoutSideLabels(left, true, gap, fontSize);
  layoutSideLabels(right, false, gap, fontSize);
}

function layoutSideLabels(arr, isLeft, gap, fontSize) {
  if (!arr.length) return;
  arr.sort((a, b) => a.y - b.y);
  const top = 0.035, bottom = 0.965;
  const ys = arr.map(it => Math.min(bottom, Math.max(top, it.y)));
  // 正向推开
  for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + gap);
  // 超出底部则反向回收
  if (ys[ys.length - 1] > bottom) {
    ys[ys.length - 1] = bottom;
    for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - gap);
  }
  const anchorX = isLeft ? 0.018 : 0.982;
  for (let i = 0; i < arr.length; i++) {
    if (ys[i] < top - 1e-6) continue;   // 实在放不下就少标一个
    const it = arr[i], ly = ys[i];
    // 引线：结构质心 → 斜线 → 贴边短横线；先画一条深色底线保证在噪声图上也能看清
    const elbowX = isLeft ? anchorX + 0.024 : anchorX - 0.024;
    const pts =
      `${(it.x * meta.w).toFixed(1)},${(it.y * meta.h).toFixed(1)} ` +
      `${(elbowX * meta.w).toFixed(1)},${(ly * meta.h).toFixed(1)} ` +
      `${(anchorX * meta.w).toFixed(1)},${(ly * meta.h).toFixed(1)}`;
    const halo = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    halo.setAttribute('points', pts);
    halo.setAttribute('fill', 'none');
    halo.setAttribute('stroke', '#000');
    halo.setAttribute('stroke-width', '2.6');
    halo.setAttribute('stroke-linecap', 'round');
    halo.setAttribute('opacity', '0.5');
    overlayEl.appendChild(halo);

    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', it.color);
    line.setAttribute('stroke-width', '1.0');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('opacity', '0.95');
    overlayEl.appendChild(line);

    // 结构端加一个小圆点，明确“这根线连的是这里”
    const dotAt = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    dotAt.setAttribute('cx', (it.x * meta.w).toFixed(1));
    dotAt.setAttribute('cy', (it.y * meta.h).toFixed(1));
    dotAt.setAttribute('r', '1.8');
    dotAt.setAttribute('fill', it.color);
    dotAt.setAttribute('opacity', '0.95');
    overlayEl.appendChild(dotAt);

    const lab = document.createElement('div');
    lab.className = 'leader-label' + (it.sid === selectedSid ? ' sel' : '');
    lab.style[isLeft ? 'left' : 'right'] = '1.2%';
    lab.style.top = (ly * 100).toFixed(2) + '%';
    lab.style.transform = 'translateY(-50%)';
    lab.style.borderLeftColor = it.color;
    lab.style.fontSize = fontSize + 'px';
    lab.title = it.name;
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = it.color;
    lab.appendChild(dot);
    lab.appendChild(document.createTextNode(it.name));
    labelsEl.appendChild(lab);
  }
}

// 总开关：轮廓和名称一起显示/隐藏；关掉后是干净影像，便于观察完整病灶
btnLabels.addEventListener('click', () => {
  annotationsOn = !annotationsOn;
  updateLabelsButton();
  drawContours(current);     // 清空 overlay（轮廓和引线共用这一层）
  renderLabels(current);     // 重新开启时重建引线
});

// ---------- 点选命中 ----------
// 射线法：判断归一化坐标 (x, y) 是否在扁平点列 poly 内
function pointInPoly(x, y, poly) {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// 鞋带公式：多边形面积（归一化坐标，仅用于"小者优先"比较）
function polyArea(poly) {
  let a = 0;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += poly[j * 2] * poly[i * 2 + 1] - poly[i * 2] * poly[j * 2 + 1];
  }
  return Math.abs(a / 2);
}

// 处理一次点选：屏幕坐标 → viewBox 坐标 → 命中面积最小的包含结构
function onTap(clientX, clientY) {
  if (!meta) return;
  const p = new DOMPoint(clientX, clientY)
    .matrixTransform(overlayEl.getScreenCTM().inverse());
  const nx = p.x / meta.w, ny = p.y / meta.h;
  const list = slices[String(current)] || [];
  let best = null, bestArea = Infinity;
  if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
    for (const item of list) {
      for (const poly of item.p) {
        if (pointInPoly(nx, ny, poly)) {
          const a = polyArea(poly);
          // 嵌套结构（如肝里的门静脉）时优先选小的
          if (a < bestArea) { bestArea = a; best = item.s; }
        }
      }
    }
  }
  selectedSid = best;
  drawContours(current);
  renderLabels(current);
  if (best) {
    const st = meta.structures.find(s => s.id === best);
    showTag(st ? (st.name_zh || st.name_en) : best);
  } else {
    hideTag();
  }
}

function showTag(text) {
  tagEl.textContent = text;
  tagEl.style.display = 'block';
}

function hideTag() {
  tagEl.style.display = 'none';
}

// ---------- 缩放 ----------
function applyScale() {
  viewport.style.transform = `translate(-50%, -50%) scale(${scale})`;
  // 线宽/字号按 1/scale 补偿，缩放后视觉粗细不变；改完 scale 必须重画
  drawMeasureOverlay();
}

function clampScale(s) { return Math.max(0.8, Math.min(10, s)); }

// ---------- 事件：滚轮（桌面） ----------
// 触控板一次滑动会连续触发很多 wheel 事件，按累计位移换算层数，
// 避免「一下滑过去十几层」，同时保留鼠标滚轮一格一层的直觉。
let wheelAccum = 0;
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) {
    scale = clampScale(scale * (e.deltaY < 0 ? 1.1 : 0.9));
    applyScale();
  } else {
    wheelAccum += e.deltaY;
    const steps = Math.trunc(wheelAccum / 45);
    if (steps !== 0) {
      wheelAccum -= steps * 45;
      show(pendingK + Math.max(-5, Math.min(5, steps)));
    }
  }
}, { passive: false });

// ---------- 事件：触摸（手机） ----------
let lastTouchY = 0;       // 上一次 touchmove 的 Y，用于累计位移
let scrubAccum = 0;       // 单指滑动累计位移（像素）
let pinchStartDist = 0;   // 双指起始间距
let pinchStartScale = 1;  // 双指起始缩放
const PX_PER_SLICE = 8;   // 每滑动 8px 翻一层（越小越跟手）

function touchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

stage.addEventListener('touchstart', (e) => {
  // 测量端点优先：手指按在已有端点上时是拖动端点，不是翻层/点选
  if (e.touches.length === 1 && measureOn) {
    const idx = measureHitTest(e.touches[0].clientX, e.touches[0].clientY);
    if (idx >= 0) { measureDrag = idx; return; }
  }
  // ROI 优先：手指落在框内或四角手柄上时，拖框而不是切层
  if (e.touches.length === 1 && roiOn && roiCircle) {
    const p = roiToNorm(e.touches[0].clientX, e.touches[0].clientY);
    const mode = roiHitTest(p);
    if (mode) {
      roiDrag = { sx: p.x, sy: p.y, orig: { cx: roiCircle.cx, cy: roiCircle.cy } };
      roiMoved = false;
      return;
    }
  }
  if (e.touches.length === 1) {
    lastTouchY = e.touches[0].clientY;
    scrubAccum = 0;
    pinching = false;
  } else if (e.touches.length === 2) {
    pinching = true;
    pinchStartDist = touchDist(e.touches);
    pinchStartScale = scale;
  }
}, { passive: true });

stage.addEventListener('touchmove', (e) => {
  e.preventDefault(); // 关键：阻止页面缩放/滚动
  // 拖动测量端点：只改这一个点，不翻层
  if (measureDrag >= 0 && e.touches.length === 1) {
    moveMeasurePoint(measureDrag, e.touches[0].clientX, e.touches[0].clientY);
    return;
  }
  if (roiDrag && e.touches.length === 1) {
    applyRoiDrag(roiToNorm(e.touches[0].clientX, e.touches[0].clientY));
    roiMoved = true;
    return;
  }
  if (pinching && e.touches.length === 2) {
    scale = clampScale(pinchStartScale * touchDist(e.touches) / pinchStartDist);
    applyScale();
  } else if (!pinching && e.touches.length === 1) {
    // 连续拖动：累计移动距离换算层数，每 8px 一层（原来是 28px 才跳一层，台阶感重）
    const y = e.touches[0].clientY;
    scrubAccum += y - lastTouchY;
    lastTouchY = y;
    const steps = Math.trunc(scrubAccum / PX_PER_SLICE);
    if (steps !== 0) {
      scrubAccum -= steps * PX_PER_SLICE;
      // 上滑（dy<0 → steps<0）→ 层号增大，符合影像浏览习惯
      show(pendingK - steps);
    }
  }
}, { passive: false });

stage.addEventListener('touchend', (e) => {
  // 刚拖完测量端点：抬手不要当成点选/继续加点
  if (measureDrag >= 0) {
    measureDrag = -1;
    suppressTap = true;
    return;
  }
  if (roiDrag) {
    roiDrag = null;
    if (roiMoved) suppressTap = true;   // 拖过框就别再当成点选结构
    return;
  }
  if (e.touches.length === 0) {
    pinching = false;
  } else if (e.touches.length === 1) {
    // 双指抬起一指后继续单指滑动：重置累计基准，避免跳层
    pinching = false;
    lastTouchY = e.touches[0].clientY;
    scrubAccum = 0;
  }
}, { passive: true });

// 点选：统一走 click（手机 tap 与桌面点击均合成 click；滑动不产生 click）
stage.addEventListener('click', (e) => {
  if (suppressTap) { suppressTap = false; return; }   // 刚拖完 ROI / 测量端点，不当点选
  // 测量模式下，点击是在取点，不再做结构点选
  if (measureOn) { onMeasureTap(e.clientX, e.clientY); return; }
  onTap(e.clientX, e.clientY);
});

// 桌面端拖动测量端点：鼠标按下 → 移动 → 抬起
stage.addEventListener('mousedown', (e) => {
  if (measureOn) {
    const idx = measureHitTest(e.clientX, e.clientY);
    if (idx >= 0) { e.preventDefault(); measureDrag = idx; return; }
  }
  if (!roiOn || !roiCircle) return;
  const p = roiToNorm(e.clientX, e.clientY);
  const mode = roiHitTest(p);
  if (!mode) return;
  e.preventDefault();
  roiDrag = { sx: p.x, sy: p.y, orig: { cx: roiCircle.cx, cy: roiCircle.cy } };
  roiMoved = false;
});
window.addEventListener('mousemove', (e) => {
  if (measureDrag >= 0) {
    moveMeasurePoint(measureDrag, e.clientX, e.clientY);
    return;
  }
  if (!roiDrag) return;
  applyRoiDrag(roiToNorm(e.clientX, e.clientY));
  roiMoved = true;
});
window.addEventListener('mouseup', () => {
  if (measureDrag >= 0) {
    measureDrag = -1;
    suppressTap = true;
    return;
  }
  if (!roiDrag) return;
  roiDrag = null;
  if (roiMoved) suppressTap = true;
});

// ---------- 事件：控制条 ----------
slider.addEventListener('input', () => show(parseInt(slider.value, 10)));
// 按钮/键盘以「用户最后请求的层」为基准：连点不会因为图像还没上屏而丢步
document.getElementById('btn-prev').addEventListener('click', () => show(pendingK - 1));
document.getElementById('btn-next').addEventListener('click', () => show(pendingK + 1));
document.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowUp') show(pendingK - 1);
  if (e.key === 'ArrowDown') show(pendingK + 1);
});

// ============================================================
// ROI 测量：框内像素 → CT 值（HU）/ 相对灰度 + 面积
// ------------------------------------------------------------
// 原理：把当前层已解码的 Image 画进离屏 canvas，读 getImageData，
// 再用 meta.window 的窗宽窗位把 0–255 灰度线性还原成 HU：
//     HU = (灰度 - 128) / 255 * 窗宽 + 窗位
// 前提：切片必须能以 CORS 模式加载（线上 assets 子域已加 Access-Control-Allow-Origin），
// 否则 canvas 被污染，getImageData 会抛 SecurityError。
// 注意：切片是 8bit 有损 webp，结果只是估算，不能当诊断值。
// ============================================================

const SVGNS = 'http://www.w3.org/2000/svg';

let roiOn = false;        // ROI 是否开启
// 圆形 ROI：cx/cy 为圆心（归一化 0..1），d 为直径（占图像短边的比例）
let roiCircle = { cx: 0.5, cy: 0.5, d: 0.30 };
let roiDrag = null;       // 拖动状态 {sx, sy, orig}
let roiMoved = false;     // 本轮拖动是否真的移动过
let suppressTap = false;  // 刚拖完 ROI，别把抬手当成点选结构
let roiLayerEl = null;    // 独立 SVG 层：和轮廓层分开，互不清空
let roiPanelEl = null;    // 结果面板

// 离屏 canvas：复用同一块，避免每次拖动都新建
const roiCanvas = document.createElement('canvas');
const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

/** 屏幕上的一点 → 归一化图像坐标。
 *  直接用 <img> 的屏幕矩形换算：CSS 缩放/平移都已经反映在
 *  getBoundingClientRect() 里，不依赖 SVG 的 CTM。
 *  （早先用 getScreenCTM() 反推，图像放大后换算会失真，表现为「放大后框拖不动」） */
function roiToNorm(clientX, clientY) {
  const b = sliceEl.getBoundingClientRect();
  if (!b.width || !b.height) return { x: -1, y: -1 };
  return { x: (clientX - b.left) / b.width, y: (clientY - b.top) / b.height };
}

/** 能否按 HU 解释：必须是 CT，且记录的是真实窗宽窗位。
 *  128/255 是「源数据已经是 8bit」的占位值，不是真实窗，按灰度处理。 */
function roiHuMode() {
  const w = meta && meta.window;
  return !!(meta && meta.modality === 'CT' && w &&
            Number(w.width) > 1.5 && Number(w.width) !== 255);
}

/** 灰度 0–255 → 物理值（HU 或原样返回灰度） */
function roiToValue(g) {
  if (!roiHuMode()) return g;
  const w = meta.window;
  return (g - 128) / 255 * Number(w.width) + Number(w.center);
}

/** ROI 圆覆盖范围（像素坐标），pad 为额外的屏幕容差（图像像素） */
function roiRadiusPx(pad = 0) {
  return roiCircle.d / 2 * Math.min(meta.w, meta.h) + pad;
}

/** 归一化坐标点是否落在 ROI 圆内；pad 用于扩大命中范围方便手指抓取 */
function roiCovers(nx, ny, pad = 0) {
  if (!roiCircle) return false;
  const R = roiRadiusPx(pad);
  const dx = nx * meta.w - roiCircle.cx * meta.w;
  const dy = ny * meta.h - roiCircle.cy * meta.h;
  return dx * dx + dy * dy <= R * R;
}

/** 命中测试：只有「在圆内 → 拖动」一种。大小由面板滑动条控制，不再用手拉角。 */
function roiHitTest(p) {
  // 手指比像素粗，命中范围放大 12 个屏幕像素（换算成图像像素要除以缩放）
  return roiCovers(p.x, p.y, 12 / Math.max(scale, 0.001)) ? 'move' : null;
}

/** 拖动：整体平移，圆心不越出图像边界 */
function applyRoiDrag(p) {
  if (!roiDrag || !roiCircle) return;
  const W = meta.w, H = meta.h;
  const R = roiRadiusPx();
  // 位移换算成图像像素后再夹住，保证整个圆留在图内
  let cx = roiDrag.orig.cx * W + (p.x - roiDrag.sx) * W;
  let cy = roiDrag.orig.cy * H + (p.y - roiDrag.sy) * H;
  cx = Math.min(Math.max(R, cx), W - R);
  cy = Math.min(Math.max(R, cy), H - R);
  roiCircle = { cx: cx / W, cy: cy / H, d: roiCircle.d };
  drawRoiOverlay();
  updateRoiStats();
}

/** 面板滑动条：设置 ROI 直径（占图像短边百分比），圆心不变、超界自动收回 */
function setRoiDiameter(pct) {
  if (!roiCircle) return;
  const W = meta.w, H = meta.h;
  const d = Math.max(0.04, Math.min(0.9, pct / 100));
  const R = d / 2 * Math.min(W, H);
  let cx = roiCircle.cx * W, cy = roiCircle.cy * H;
  cx = Math.min(Math.max(R, cx), W - R);
  cy = Math.min(Math.max(R, cy), H - R);
  roiCircle = { cx: cx / W, cy: cy / H, d };
  drawRoiOverlay();
  updateRoiStats();
}

/** 在独立图层上画 ROI 圆（线宽随缩放反向补偿，视觉粗细恒定） */
function drawRoiOverlay() {
  if (!roiLayerEl) return;
  roiLayerEl.innerHTML = '';
  if (!roiOn || !roiCircle) return;

  const k = 1 / Math.max(scale, 0.001);   // 抵消 viewport 的 CSS 缩放
  const c = document.createElementNS(SVGNS, 'circle');
  c.setAttribute('cx', roiCircle.cx * meta.w);
  c.setAttribute('cy', roiCircle.cy * meta.h);
  c.setAttribute('r', roiRadiusPx());
  c.setAttribute('fill', 'rgba(255,209,102,.08)');
  c.setAttribute('stroke', '#ffd166');
  c.setAttribute('stroke-width', 2 * k);
  c.setAttribute('stroke-dasharray', `${6 * k} ${4 * k}`);
  roiLayerEl.appendChild(c);
}

/** 采样当前层 ROI 区域，返回统计结果 */
function sampleRoi() {
  const im = imgCache.get(current);
  if (!im || !roiCircle) return null;

  const W = meta.w, H = meta.h;
  if (roiCanvas.width !== W || roiCanvas.height !== H) {
    roiCanvas.width = W; roiCanvas.height = H;
  }
  // 只取圆的包围盒，盒内的圆外像素在下面逐点判定时跳过
  const Rp = roiRadiusPx();
  const x0 = Math.max(0, Math.floor(roiCircle.cx * W - Rp));
  const y0 = Math.max(0, Math.floor(roiCircle.cy * H - Rp));
  const x1 = Math.min(W, Math.ceil(roiCircle.cx * W + Rp));
  const y1 = Math.min(H, Math.ceil(roiCircle.cy * H + Rp));
  const bw = Math.max(1, x1 - x0), bh = Math.max(1, y1 - y0);

  let d;
  try {
    roiCtx.clearRect(0, 0, W, H);
    roiCtx.drawImage(im, 0, 0, W, H);
    d = roiCtx.getImageData(x0, y0, bw, bh).data;
  } catch (err) {
    // 跨域被污染：服务端没给 CORS 头
    return { error: 'cors' };
  }

  // 逐像素统计：只算椭圆内部的像素（灰度图三通道相同，取 R 通道即可）
  let n = 0, sum = 0, sumSq = 0, mn = Infinity, mx = -Infinity;
  let clipped = 0;   // 灰度卡在 0 或 255 的像素数（背景或窗外组织）
  const vals = new Float32Array(bw * bh);
  for (let yy = y0; yy < y1; yy++) {
    const ny = (yy + 0.5) / H;
    for (let xx = x0; xx < x1; xx++) {
      const nx = (xx + 0.5) / W;
      if (!roiCovers(nx, ny)) continue;   // 椭圆外的像素直接跳过
      const g = d[((yy - y0) * bw + (xx - x0)) * 4];
      if (g === 0 || g === 255) clipped++;
      const v = roiToValue(g);
      vals[n++] = v;
      sum += v; sumSq += v * v;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
  }
  const mean = n ? sum / n : 0;
  const sd = n ? Math.sqrt(Math.max(0, sumSq / n - mean * mean)) : 0;

  // 20 个 bin 的直方图
  const BINS = 20;
  const hist = new Array(BINS).fill(0);
  const span = mx - mn;
  for (let i = 0; i < n; i++) {
    let b = span > 1e-9 ? Math.floor((vals[i] - mn) / span * BINS) : 0;
    if (b >= BINS) b = BINS - 1;
    if (b < 0) b = 0;
    hist[b]++;
  }

  // 面积：按椭圆内实际计入的像素数算（不是外接矩形），
  // 有 spacing 就给 mm²，否则只报像素数
  const sp = meta.spacing;
  const areaPx = n;
  const areaMm2 = (sp && sp.length >= 2) ? areaPx * Number(sp[0]) * Number(sp[1]) : null;

  // clippedRatio：纯黑/纯白像素占比。接近 1 说明框基本落在背景或窗外，
  // 此时均值没有临床意义（看起来像"归零"，其实是顶到了窗宽边界）。
  return { n, mean, sd, mn, mx, hist, areaPx, areaMm2, clippedRatio: n ? clipped / n : 0 };
}

/** 把统计结果写进面板 */
function updateRoiStats() {
  if (!roiOn || !roiPanelEl) return;
  const st = sampleRoi();
  const q = (id) => roiPanelEl.querySelector('#' + id);

  if (!st || st.error) {
    q('roi-area').textContent = '—';
    q('roi-mean').textContent = '—';
    q('roi-sd').textContent = '—';
    q('roi-range').textContent = '—';
    q('roi-hist').innerHTML = '';
    q('roi-note').textContent = st && st.error === 'cors'
      ? '无法读取像素：切片跨域未开放 CORS'
      : '等待当前层加载…';
    return;
  }

  const hu = roiHuMode();
  const unit = hu ? ' HU' : '';
  const fmt = (v) => hu ? v.toFixed(1) : Math.round(v);

  // 单位必须一眼可辨：CT 才是 HU，其余模态/截图病例只有 0–255 灰度
  q('roi-mode').textContent = hu ? 'CT 值 · HU' : '相对灰度 · 非 HU';
  q('roi-mode').classList.toggle('gray', !hu);
  // 面积只显示 mm²；像素数放进「数值说明」，避免把 2×2 网格撑爆
  q('roi-area').textContent = st.areaMm2 !== null
    ? `${st.areaMm2.toFixed(0)} mm²`
    : `${st.areaPx} px`;
  q('roi-mean').textContent = fmt(st.mean) + unit;
  q('roi-sd').textContent = (hu ? st.sd.toFixed(1) : Math.round(st.sd)) + unit;
  q('roi-range').textContent = `${fmt(st.mn)}~${fmt(st.mx)}${unit}`;

  // 直方图：用 div 高度表示频数
  const maxCount = Math.max(...st.hist, 1);
  q('roi-hist').innerHTML = st.hist
    .map(c => `<i style="height:${Math.max(2, Math.round(c / maxCount * 100))}%"></i>`)
    .join('');

  // 8bit 切片的灰度被窗宽窗位截断：窗外的组织一律顶到 0 或 255，
  // 所以可测范围只有 [窗位-窗宽/2, 窗位+窗宽/2]，空气/骨这类窗外值不可信。
  // 这段是固定说明，收在「数值说明」折叠区里，不占日常视野。
  const lo = Number(meta.window.center) - Number(meta.window.width) / 2;
  const hi = Number(meta.window.center) + Number(meta.window.width) / 2;
  q('roi-scale-note').textContent = (hu
    ? `换算：8bit 切片按窗宽窗位（${meta.window.center}/${meta.window.width}），`
      + `可测范围仅 ${lo} ~ ${hi} HU（窗外已截断），估算值、非诊断用。`
    : '非 CT 或窗值不可用，仅显示 0–255 相对灰度。')
    + ` 本次圈内 ${st.areaPx} 个像素。`;

  // 参考值按检查方式切换：MRI 只有相对信号（无绝对单位），CT 才有 HU 标准值
  const refEl = document.querySelector('.roi-ref');
  if (refEl) {
    const isMri = String(meta.modality || '').toUpperCase().indexOf('MRI') >= 0;
    refEl.innerHTML = isMri
      ? '<b>MRI 相对信号参考</b>（无绝对单位，仅同序列内比较）<br>'
        + 'T1WI：脂肪 / 白质高 · 水 / 脑脊液低<br>'
        + 'T2WI：水 / 脑脊液高 · 灰质 &gt; 白质<br>'
        + 'DWI：弥散受限呈高信号（ADC 低）'
      : '<b>参考 CT 值（HU）</b><br>'
        + '空气 −1000 · 肺 −700~−900 · 脂肪 −100~−50 · 水 0 · '
        + '软组织 20~60 · 急性血肿 50~80 · 钙化/骨 100~1000+ · 对比剂 100~600+';
  }

  // 圈基本落在背景/窗外时给个明确提示（这条必须一直可见，不能折叠）
  q('roi-note').textContent = st.clippedRatio >= 0.9
    ? `⚠️ 约 ${Math.round(st.clippedRatio * 100)}% 像素是纯黑/纯白（背景或窗外组织），`
      + '这组数值没有意义，请把圈移到解剖区域内。'
    : '';
}

/** 开 / 关 ROI */
function toggleRoi() {
  roiOn = !roiOn;
  // ROI 和测量共用底部面板位置，同一时间只开一个
  if (roiOn && measureOn) setMeasureOn(false);
  const btn = document.getElementById('btn-roi');
  if (btn) btn.classList.toggle('active', roiOn);

  if (roiOn) {
    roiPanelEl.style.display = 'block';
  } else {
    roiPanelEl.style.display = 'none';
  }
  updateStageOffset();   // 面板展开/收起后重新计算图像要上移多少
  drawRoiOverlay();
  updateRoiStats();
}

/** 底部 HUD 和 ROI 面板会盖住图像下沿：按它们的实际高度把图像整体上移一半，
 *  让图像在「没有被遮挡的那块区域」里居中。用 top 偏移而不是改 stage 高度，
 *  这样整屏仍然可以滑动切层。 */
function updateStageOffset() {
  const hud = document.getElementById('hud');
  const hudH = hud ? hud.offsetHeight : 64;
  // ROI 面板与测量面板互斥，取当前展开那个的高度
  const roiH = roiPanelEl && roiPanelEl.style.display !== 'none'
    ? roiPanelEl.offsetHeight + 10 : 0;
  const msH = measurePanelEl && measurePanelEl.style.display !== 'none'
    ? measurePanelEl.offsetHeight + 10 : 0;
  const shift = Math.round((hudH + Math.max(roiH, msH)) / 2);
  viewport.style.top = shift > 0 ? `calc(50% - ${shift}px)` : '50%';
}

/** 当前层变化时同步 ROI 图层 */
function updateRoiLayer() {
  if (!roiOn) return;
  drawRoiOverlay();
  updateRoiStats();
}

/** 注入 ROI 的样式（不进每个病例的 style.css，只维护 viewer.js 一份） */
function injectRoiStyle() {
  if (document.getElementById('roi-style')) return;
  const css = document.createElement('style');
  css.id = 'roi-style';
  css.textContent = `
    /* 图像上移时平滑过渡，避免开/关面板时画面跳一下 */
    #viewport { transition: top .22s ease; }
    #btn-roi { position: fixed; left: 14px;
      top: calc(58px + env(safe-area-inset-top)); height: 36px; padding: 0 13px;
      border-radius: 18px; border: 1px solid rgba(140,180,230,.35);
      background: rgba(18,28,48,.86); color: #9fb4d0; font-size: 12.5px;
      z-index: 15; cursor: pointer; }
    #btn-roi.active { background: #2563eb; border-color: #2563eb; color: #fff; }
    #roi-panel { position: fixed; left: 14px; right: 14px;
      bottom: calc(78px + env(safe-area-inset-bottom));
      display: none; z-index: 16; padding: 9px 13px 10px;
      background: rgba(12,20,34,.94); border: 1px solid #22304a;
      border-radius: 14px; color: #dbe3ef; font-size: 13px;
      box-shadow: 0 8px 30px rgba(0,0,0,.45); }
    #roi-panel .roi-hd { font-size: 13px; color: #9fb4d0; margin-bottom: 4px;
      display: flex; justify-content: space-between; }
    #roi-panel .roi-hd span { color: #0d1520; background: #ffd166;
      border-radius: 9px; padding: 1px 8px; font-size: 11.5px; font-weight: 600; }
    /* 非 HU 模式用灰色徽标，和 CT 值的黄标区分开 */
    #roi-panel .roi-hd span.gray { background: #5a6678; color: #e8eef8; }
    #roi-panel .roi-size { display: flex; align-items: center; gap: 8px;
      margin: 0 0 6px; font-size: 12px; color: #7f8da3; }
    #roi-panel .roi-size input[type=range] { flex: 1; accent-color: #ffd166;
      height: 20px; }
    #roi-panel .roi-size b { color: #ffd166; font-variant-numeric: tabular-nums;
      min-width: 34px; text-align: right; font-weight: 600; }
    /* 2×2 网格：两行放完四个指标，比四行省一半高度 */
    #roi-panel .roi-grid { display: grid;
      grid-template-columns: auto 1fr auto 1fr;
      gap: 3px 8px; font-variant-numeric: tabular-nums; font-size: 12.5px; }
    #roi-panel .roi-grid span { color: #7f8da3; white-space: nowrap; }
    #roi-panel .roi-grid b { font-weight: 600; color: #eef4ff; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; }
    #roi-hist { display: flex; align-items: flex-end; gap: 2px; height: 24px;
      margin-top: 7px; background: #0b1220; border-radius: 6px; padding: 2px 4px; }
    #roi-hist i { flex: 1; background: #4ea1ff; border-radius: 1px; display: block; }
    #roi-note { margin-top: 8px; font-size: 11px; color: #ffb4a2; line-height: 1.5; }
    #roi-note:empty { display: none; }
    .roi-help { margin-top: 8px; padding-top: 7px; border-top: 1px dashed #22304a;
      font-size: 10.5px; color: #7f8da3; line-height: 1.65; }
    .roi-help summary { cursor: pointer; color: #9fb4d0; outline: none; }
    .roi-help summary::-webkit-details-marker { display: none; }
    .roi-help summary::before { content: '▸ '; }
    .roi-help[open] summary::before { content: '▾ '; }
    .roi-help-body { margin-top: 6px; }
    .roi-help-body b { color: #a8b6cc; font-weight: 600; }
    #roi-scale-note { margin-top: 6px; color: #6f7b8d; }
  `;
  document.head.appendChild(css);
}

/** 建立 ROI 图层 / 按钮 / 面板（init 里调一次） */
function initRoi() {
  injectRoiStyle();

  // 独立 SVG 图层，盖在轮廓层之上，pointer-events 关闭（拖动靠 stage 统一处理）
  roiLayerEl = document.createElementNS(SVGNS, 'svg');
  roiLayerEl.id = 'roi-layer';
  // viewBox 必须和图像像素尺寸一致，否则图层坐标系是 CSS 像素：
  // 画出来的框位置/大小会错，且 getScreenCTM() 反推的归一化坐标对不上图像，
  // 表现为「框拖不到右半边、数值随水平位置异常递减」。
  roiLayerEl.setAttribute('viewBox', `0 0 ${meta.w} ${meta.h}`);
  roiLayerEl.setAttribute('preserveAspectRatio', 'none');
  roiLayerEl.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4;';
  viewport.appendChild(roiLayerEl);

  const btn = document.createElement('button');
  btn.id = 'btn-roi';
  btn.textContent = 'ROI';
  btn.setAttribute('aria-label', 'ROI 测量');
  btn.addEventListener('click', toggleRoi);
  document.body.appendChild(btn);

  roiPanelEl = document.createElement('div');
  roiPanelEl.id = 'roi-panel';
  roiPanelEl.innerHTML = `
    <div class="roi-hd">ROI 测量<span id="roi-mode"></span></div>
    <div class="roi-size">
      <span>圆直径</span>
      <input id="roi-size" type="range" min="4" max="80" step="1" value="30">
      <b id="roi-size-val">30%</b>
    </div>
    <div class="roi-grid">
      <span>面积</span><b id="roi-area">—</b>
      <span>均值</span><b id="roi-mean">—</b>
      <span>标准差</span><b id="roi-sd">—</b>
      <span>范围</span><b id="roi-range">—</b>
    </div>
    <div id="roi-hist"></div>
    <div id="roi-note"></div>
    <details class="roi-help">
      <summary>数值说明</summary>
      <div class="roi-help-body">
        <b>面积</b> 圈内像素换算的实际面积（有像素间距才显示 mm²）<br>
        <b>均值</b> 圈内平均密度，CT 即平均 CT 值（HU）<br>
        <b>标准差</b> 圈内像素的离散程度，越大越混杂（囊肿/积液应接近 0）<br>
        <b>范围</b> 圈内最小 ~ 最大密度
        <div id="roi-scale-note"></div>
        <div class="roi-ref">
          <b>参考 CT 值（HU）</b><br>
          空气 −1000 · 肺 −700~−900 · 脂肪 −100~−50 · 水 0 ·
          软组织 20~60 · 急性血肿 50~80 · 钙化/骨 100~1000+ · 对比剂 100~600+
        </div>
      </div>
    </details>`;
  document.body.appendChild(roiPanelEl);

  // 直径滑动条：取代以前用手拉四角，圆始终是正圆
  const size = roiPanelEl.querySelector('#roi-size');
  const sizeVal = roiPanelEl.querySelector('#roi-size-val');
  size.value = Math.round(roiCircle.d * 100);
  sizeVal.textContent = size.value + '%';
  size.addEventListener('input', () => {
    const v = Number(size.value);
    sizeVal.textContent = v + '%';
    setRoiDiameter(v);
  });

  // 「数值说明」展开/收起会改变面板高度，图像的上移量要跟着重算
  roiPanelEl.querySelector('.roi-help').addEventListener('toggle', updateStageOffset);
  window.addEventListener('resize', updateStageOffset);

  // 初始按 HUD 高度先挪一次（HUD 常驻）
  setTimeout(updateStageOffset, 0);
}

// ============================================================
// 长度 / 角度测量（2026-11-01）
// 只做当前层：翻层后自动清除，避免「新层的图配上一层的线」。
// 长度单位：meta.spacing 存在才换算 mm，否则只报像素——
// 185 套里只有 36 套有真实像素间距，其余来自截图或单层 PNG。
// ============================================================

let measureOn = false;        // 测量模式是否开启
let measureMode = 'length';   // 'length' 两点测长 | 'angle' 三点测角
let measurePoints = [];       // 归一化坐标 [{x,y}]；角度时第 2 点为顶点
let measureDrag = -1;         // 正在拖动的端点下标；-1 = 没在拖
let measureLayerEl = null;    // 独立 SVG 层，和轮廓/ROI 层互不清空
let measurePanelEl = null;    // 底部读数面板
const MEASURE_HIT_PX = 16;    // 端点命中半径（屏幕像素，手指比像素粗）

/** 注入测量按钮/面板的样式（只维护 viewer.js 一份） */
function injectMeasureStyle() {
  if (document.getElementById('measure-style')) return;
  const css = document.createElement('style');
  css.id = 'measure-style';
  css.textContent = `
    /* 左侧竖排：标注 → ROI → 测量 */
    #btn-measure { position: fixed; left: 14px;
      top: calc(102px + env(safe-area-inset-top)); height: 36px; padding: 0 13px;
      border-radius: 18px; border: 1px solid rgba(140,180,230,.35);
      background: rgba(18,28,48,.86); color: #9fb4d0; font-size: 12.5px;
      z-index: 15; cursor: pointer; }
    #btn-measure.active { background: #2563eb; border-color: #2563eb; color: #fff; }
    #measure-panel { position: fixed; left: 14px; right: 14px;
      bottom: calc(78px + env(safe-area-inset-bottom));
      display: none; z-index: 16; padding: 10px 13px 11px;
      background: rgba(12,20,34,.94); border: 1px solid #22304a;
      border-radius: 14px; color: #dbe3ef; font-size: 13px;
      box-shadow: 0 8px 30px rgba(0,0,0,.45); }
    #measure-panel .ms-hd { font-size: 13px; color: #9fb4d0; margin-bottom: 6px;
      display: flex; justify-content: space-between; align-items: center; }
    #measure-panel .ms-hd span { color: #0d1520; background: #4ea1ff;
      border-radius: 9px; padding: 1px 8px; font-size: 11.5px; font-weight: 600; }
    .ms-modes { display: flex; gap: 8px; margin-bottom: 8px; }
    .ms-modes button { flex: 1; height: 34px; border-radius: 9px;
      border: 1px solid #2a3d5c; background: #101a2b; color: #9fb4d0;
      font-size: 12.5px; cursor: pointer; }
    .ms-modes button.on { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
    #ms-val { font-size: 18px; font-weight: 650; color: #eef4ff;
      font-variant-numeric: tabular-nums; }
    #ms-detail { font-size: 11.5px; color: #7f8da3; margin-top: 3px;
      line-height: 1.5; min-height: 16px; }
    .ms-foot { display: flex; align-items: center; justify-content: space-between;
      margin-top: 8px; }
    .ms-foot button { height: 34px; padding: 0 14px; border-radius: 9px;
      border: 1px solid #2a3d5c; background: #101a2b; color: #9fb4d0;
      font-size: 12.5px; cursor: pointer; }
    .ms-foot span { font-size: 11px; color: #6f7b8d; }
    .ms-note { margin-top: 8px; padding-top: 7px; border-top: 1px dashed #22304a;
      font-size: 10.5px; color: #6f7b8d; line-height: 1.5; }
  `;
  document.head.appendChild(css);
}

/** 建立测量图层、按钮和面板（init 里调一次） */
function initMeasure() {
  injectMeasureStyle();

  measureLayerEl = document.createElementNS(SVGNS, 'svg');
  measureLayerEl.id = 'measure-layer';
  // viewBox 必须与图像像素一致，否则坐标换算和线宽补偿都会错
  measureLayerEl.setAttribute('viewBox', `0 0 ${meta.w} ${meta.h}`);
  measureLayerEl.setAttribute('preserveAspectRatio', 'none');
  measureLayerEl.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5;';
  viewport.appendChild(measureLayerEl);

  const btn = document.createElement('button');
  btn.id = 'btn-measure';
  btn.textContent = '测量';
  btn.setAttribute('aria-label', '长度或角度测量');
  btn.addEventListener('click', () => setMeasureOn(!measureOn));
  document.body.appendChild(btn);

  measurePanelEl = document.createElement('div');
  measurePanelEl.id = 'measure-panel';
  measurePanelEl.innerHTML = `
    <div class="ms-hd">测量<span id="ms-mode">长度</span></div>
    <div class="ms-modes">
      <button id="ms-len" class="on" type="button">长度</button>
      <button id="ms-ang" type="button">角度</button>
    </div>
    <div id="ms-val">在图像上点两点</div>
    <div id="ms-detail"></div>
    <div class="ms-foot"><button id="ms-clear" type="button">清除</button>
      <span>翻层自动清除</span></div>
    <div class="ms-note">仅供学习与复盘，不替代临床工作站测量</div>`;
  document.body.appendChild(measurePanelEl);

  measurePanelEl.querySelector('#ms-len')
    .addEventListener('click', () => setMeasureMode('length'));
  measurePanelEl.querySelector('#ms-ang')
    .addEventListener('click', () => setMeasureMode('angle'));
  measurePanelEl.querySelector('#ms-clear')
    .addEventListener('click', () => clearMeasure(false));

  setTimeout(updateStageOffset, 0);
}

/** 开 / 关测量；与 ROI 面板互斥 */
function setMeasureOn(on) {
  measureOn = !!on;
  const btn = document.getElementById('btn-measure');
  if (btn) btn.classList.toggle('active', measureOn);

  // 两个面板占同一个位置，只能开一个
  if (measureOn && roiOn) toggleRoi();

  measurePanelEl.style.display = measureOn ? 'block' : 'none';
  // 关闭时清掉旧点，下次打开不会看到上一组的线
  if (!measureOn) { measurePoints = []; measureDrag = -1; }
  updateStageOffset();
  drawMeasureOverlay();
  updateMeasurePanel();
}

/** 切换长度 / 角度：换模式就重新取点 */
function setMeasureMode(mode) {
  measureMode = mode;
  measurePoints = [];
  measureDrag = -1;
  const len = document.getElementById('ms-len');
  const ang = document.getElementById('ms-ang');
  if (len) len.classList.toggle('on', mode === 'length');
  if (ang) ang.classList.toggle('on', mode === 'angle');
  const badge = document.getElementById('ms-mode');
  if (badge) badge.textContent = mode === 'length' ? '长度' : '角度';
  drawMeasureOverlay();
  updateMeasurePanel();
}

/** 清除当前测量；tip=true 时给「翻层已清除」提示 */
function clearMeasure(tip) {
  if (!measurePoints.length) return;
  measurePoints = [];
  measureDrag = -1;
  drawMeasureOverlay();
  updateMeasurePanel();
  if (tip) showTag('已切换层面，测量已清除');
}

/** 测量模式下的一次点击：取点 */
function onMeasureTap(clientX, clientY) {
  const p = roiToNorm(clientX, clientY);
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
  const need = measureMode === 'length' ? 2 : 3;
  // 上一组已经画完：这一下开始新的一组
  if (measurePoints.length >= need) measurePoints = [];
  measurePoints.push(p);
  drawMeasureOverlay();
  updateMeasurePanel();
}

/** 拖动端点：更新指定下标并重画 */
function moveMeasurePoint(idx, clientX, clientY) {
  const p = roiToNorm(clientX, clientY);
  if (p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return;
  if (!measurePoints[idx]) return;
  measurePoints[idx] = p;
  drawMeasureOverlay();
  updateMeasurePanel();
}

/** 端点命中测试：返回下标，没命中返回 -1 */
function measureHitTest(clientX, clientY) {
  if (!measureOn || !measurePoints.length) return -1;
  const p = roiToNorm(clientX, clientY);
  const tol = MEASURE_HIT_PX / Math.max(scale, 0.001);  // 屏幕像素 → 图像像素
  for (let i = 0; i < measurePoints.length; i++) {
    const q = measurePoints[i];
    const dx = (p.x - q.x) * meta.w;
    const dy = (p.y - q.y) * meta.h;
    if (Math.hypot(dx, dy) <= tol) return i;
  }
  return -1;
}

/** 计算结果：返回 {text, detail}，点数不够或退化时返回 null */
function measureResult() {
  const sp = meta.spacing;
  const hasSp = !!(sp && sp.length >= 2 && Number(sp[0]) > 0 && Number(sp[1]) > 0);

  if (measureMode === 'length' && measurePoints.length >= 2) {
    const [a, b] = measurePoints;
    const dx = (b.x - a.x) * meta.w;
    const dy = (b.y - a.y) * meta.h;
    if (hasSp) {
      const sx = Number(sp[0]), sy = Number(sp[1]);
      const mm = Math.hypot(dx * sx, dy * sy);
      return {
        text: `${mm.toFixed(1)} mm`,
        detail: `像素间距 ${sx} × ${sy} mm`,
      };
    }
    // 没有像素间距就只报像素，绝不显示估算毫米
    return {
      text: `${Math.hypot(dx, dy).toFixed(0)} px`,
      detail: '该图像无可靠像素间距，无法换算为 mm',
    };
  }

  if (measureMode === 'angle' && measurePoints.length >= 3) {
    const [a, b, c] = measurePoints;
    // 有间距时按物理比例算，避免非方形像素把角度算偏
    const sx = hasSp ? Number(sp[0]) : 1;
    const sy = hasSp ? Number(sp[1]) : 1;
    const v1 = { x: (a.x - b.x) * meta.w * sx, y: (a.y - b.y) * meta.h * sy };
    const v2 = { x: (c.x - b.x) * meta.w * sx, y: (c.y - b.y) * meta.h * sy };
    const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
    if (!n1 || !n2) return null;
    const cos = Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (n1 * n2)));
    const deg = Math.acos(cos) * 180 / Math.PI;
    return {
      text: `${deg.toFixed(1)}°`,
      detail: hasSp ? '角度已按像素间距校正' : '角度按像素比例计算',
    };
  }
  return null;
}

/** 在图像像素坐标下画一条测量线；线宽随缩放反向补偿 */
function drawMeasureLine(a, b, k) {
  const l = document.createElementNS(SVGNS, 'line');
  l.setAttribute('x1', a.x); l.setAttribute('y1', a.y);
  l.setAttribute('x2', b.x); l.setAttribute('y2', b.y);
  l.setAttribute('stroke', '#4ea1ff');
  l.setAttribute('stroke-width', 2 * k);
  l.setAttribute('stroke-linecap', 'round');
  measureLayerEl.appendChild(l);
}

/** 角度的圆弧：以第 2 点为圆心，取两条射线之间的较小夹角 */
function drawMeasureArc(pts, k) {
  const [a, b, c] = pts;
  const r = 26 * k;
  const a1 = Math.atan2(a.y - b.y, a.x - b.x);
  const a2 = Math.atan2(c.y - b.y, c.x - b.x);
  let diff = a2 - a1;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  const sx = b.x + r * Math.cos(a1), sy = b.y + r * Math.sin(a1);
  const ex = b.x + r * Math.cos(a1 + diff), ey = b.y + r * Math.sin(a1 + diff);
  const path = document.createElementNS(SVGNS, 'path');
  path.setAttribute('d', `M ${sx} ${sy} A ${r} ${r} 0 0 ${diff > 0 ? 1 : 0} ${ex} ${ey}`);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#ffd166');
  path.setAttribute('stroke-width', 1.6 * k);
  measureLayerEl.appendChild(path);
}

/** 把读数画在测量图形旁边；用描边做底，压在明暗图像上都看得清 */
function drawMeasureLabel(pts, text, k) {
  let x, y;
  if (measureMode === 'length') {
    x = (pts[0].x + pts[1].x) / 2;
    y = (pts[0].y + pts[1].y) / 2 - 12 * k;
  } else {
    x = pts[1].x + 14 * k;
    y = pts[1].y - 14 * k;
  }
  const t = document.createElementNS(SVGNS, 'text');
  t.setAttribute('x', x); t.setAttribute('y', y);
  t.setAttribute('fill', '#eaf2ff');
  t.setAttribute('font-size', 13 * k);
  t.setAttribute('font-weight', '600');
  t.setAttribute('stroke', 'rgba(0,0,0,.8)');
  t.setAttribute('stroke-width', 4 * k);
  t.setAttribute('paint-order', 'stroke');
  t.textContent = text;
  measureLayerEl.appendChild(t);
}

/** 重画测量图层（开关、模式、缩放、拖端点、翻层都会调） */
function drawMeasureOverlay() {
  if (!measureLayerEl) return;
  measureLayerEl.innerHTML = '';
  if (!measureOn || !measurePoints.length) return;

  const k = 1 / Math.max(scale, 0.001);   // 抵消 viewport 的 CSS 缩放
  const pts = measurePoints.map(p => ({ x: p.x * meta.w, y: p.y * meta.h }));

  if (measureMode === 'length' && pts.length >= 2) {
    drawMeasureLine(pts[0], pts[1], k);
  } else if (measureMode === 'angle' && pts.length >= 3) {
    drawMeasureLine(pts[0], pts[1], k);
    drawMeasureLine(pts[1], pts[2], k);
    drawMeasureArc(pts, k);
  }

  // 端点画在线之后，盖住线头
  pts.forEach((p) => {
    const c = document.createElementNS(SVGNS, 'circle');
    c.setAttribute('cx', p.x); c.setAttribute('cy', p.y);
    c.setAttribute('r', 4.5 * k);
    c.setAttribute('fill', '#4ea1ff');
    c.setAttribute('stroke', '#fff');
    c.setAttribute('stroke-width', 1.5 * k);
    measureLayerEl.appendChild(c);
  });

  const r = measureResult();
  if (r) drawMeasureLabel(pts, r.text, k);
}

/** 刷新底部面板上的读数 */
function updateMeasurePanel() {
  if (!measurePanelEl) return;
  const val = measurePanelEl.querySelector('#ms-val');
  const detail = measurePanelEl.querySelector('#ms-detail');
  const need = measureMode === 'length' ? 2 : 3;
  const r = measureResult();
  if (r) {
    val.textContent = r.text;
    detail.textContent = r.detail;
  } else if (measurePoints.length > 0) {
    val.textContent = `已取 ${measurePoints.length} / ${need} 点`;
    detail.textContent = measureMode === 'length'
      ? '再点一个点完成测量'
      : '依次点三点，第二点为角的顶点';
  } else {
    val.textContent = measureMode === 'length' ? '在图像上点两点' : '依次点三点（第二点为顶点）';
    detail.textContent = '';
  }
}

// ============================================================
// 收藏 / 最近访问 / 病例笔记（2026-11-01）
// 数据只存本机 localStorage，不上传；换设备或清应用数据会丢。
// 与 myindex.html 的「个人记录」是两套数据：那边是结构化病例索引，
// 这边只是「收藏夹 + 一句话笔记」，故意保持轻量。
// ============================================================

// 收藏 / 最近 / 笔记统一走 static/person-store.js（atlas_person_v2）
let marks = {};             // 当前收藏/笔记的内存副本（PersonStore.load().items）
let noteTimer = null;       // 笔记输入的防抖定时器
let btnFav = null;          // ★ 收藏按钮
let btnNote = null;         // ✎ 笔记按钮
let noteBackdrop = null;    // 笔记抽屉遮罩
let noteArea = null;        // 笔记文本框
let noteStatus = null;      // 「已保存」提示

/** 注入按钮和笔记抽屉的样式（只维护 viewer.js 一份，不进每个病例的 style.css） */
function injectMarksStyle() {
  if (document.getElementById('marks-style')) return;
  const css = document.createElement('style');
  css.id = 'marks-style';
  css.textContent = `
    /* 右上角「i」下面并排两个圆按钮：收藏 / 笔记 */
    #btn-fav, #btn-note { position: fixed; right: 14px; width: 40px; height: 40px;
      border-radius: 50%; border: 1px solid rgba(140,180,230,.35);
      background: rgba(18,28,48,.86); color: #9fb4d0; font-size: 18px;
      z-index: 15; cursor: pointer; line-height: 1; }
    #btn-fav { top: calc(62px + env(safe-area-inset-top)); }
    #btn-note { top: calc(110px + env(safe-area-inset-top)); font-size: 17px; }
    /* 收藏后星标变金色，一眼能看出状态 */
    #btn-fav.on { color: #ffd166; border-color: rgba(255,209,102,.65);
      background: rgba(58,46,18,.92); }
    #note-backdrop { position: fixed; inset: 0; z-index: 30;
      background: rgba(0,0,0,.55); display: flex; align-items: flex-end;
      justify-content: center; }
    #note-backdrop.hidden { display: none; }
    #note-sheet { width: 100%; max-width: 640px; background: #0f1622;
      color: #e8e8e8; border: 1px solid #22304a;
      border-radius: 18px 18px 0 0; box-shadow: 0 -10px 40px rgba(0,0,0,.5);
      display: flex; flex-direction: column; }
    #note-head { display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px; border-bottom: 1px solid #1c2738;
      font-size: 16px; font-weight: 600; color: #dfe8f5; }
    #note-head button { width: 34px; height: 34px; border: none; border-radius: 50%;
      background: rgba(255,255,255,.08); color: #aab8cc; font-size: 16px; }
    #note-body { padding: 14px 18px calc(18px + env(safe-area-inset-bottom)); }
    #note-area { width: 100%; min-height: 140px; resize: vertical;
      background: #0b1220; color: #e8eef8; border: 1px solid #22304a;
      border-radius: 10px; padding: 10px 12px; font-size: 14px; line-height: 1.6;
      font-family: inherit; outline: none; }
    #note-area:focus { border-color: #3b6ea8; }
    #note-foot { display: flex; justify-content: space-between; align-items: center;
      margin-top: 8px; font-size: 12px; color: #7f8da3; }
    #note-status { color: #6fbf73; }
    @media (min-width: 700px) {
      #note-backdrop { align-items: center; }
      #note-sheet { border-radius: 16px; }
    }
  `;
  document.head.appendChild(css);
}

/** 同步 ★ 按钮的选中态 */
function syncFavButton() {
  if (!btnFav) return;
  const on = !!(marks[meta.case_id] && marks[meta.case_id].starred);
  btnFav.classList.toggle('on', on);
  btnFav.setAttribute('aria-pressed', on ? 'true' : 'false');
  btnFav.setAttribute('aria-label', on ? '取消收藏本例' : '收藏本例');
}

/** 收藏 / 取消收藏 */
async function toggleFav() {
  if (PersonStore.isReadonly()) { showTag('本地收藏数据损坏，已停止写入'); return; }
  const id = meta.case_id;
  const wasFav = !!(marks[id] && marks[id].starred);
  const res = await PersonStore.toggleFav(id);
  if (!res) { showTag('保存失败：本地存储不可用'); return; }
  marks = res.items;
  syncFavButton();
  showTag(wasFav ? '已取消收藏' : '已收藏');
}

/** 打开笔记抽屉：每次都从存储里重读，避免用旧副本覆盖别处刚写的内容 */
function openNote() {
  const rec = marks[meta.case_id] || {};
  noteArea.value = rec.note || '';
  noteStatus.textContent = '';
  noteBackdrop.classList.remove('hidden');
  noteArea.focus();
}

function closeNote() {
  noteBackdrop.classList.add('hidden');
}

/** 保存笔记（500ms 防抖）：空内容视为删除笔记，但保留收藏状态 */
async function saveNote() {
  if (PersonStore.isReadonly()) { noteStatus.textContent = '本地数据损坏，已停止写入'; return; }
  const id = meta.case_id;
  const text = noteArea.value.trim();
  const res = await PersonStore.setNote(id, text);
  if (!res) { noteStatus.textContent = '保存失败'; return; }
  marks = res.items;
  noteStatus.textContent = text ? '已保存' : '已清空';
}

/** 记录最近访问：同一病例只更新时间，不重复插入 */
async function recordRecent() {
  const id = meta.case_id;
  if (!id) return;
  await PersonStore.touchRecent(id);
}

/** 建立收藏按钮、笔记按钮和笔记抽屉（init 里调一次） */
function initMarks() {
  injectMarksStyle();
  marks = PersonStore.load().items;

  btnFav = document.createElement('button');
  btnFav.id = 'btn-fav';
  btnFav.textContent = '★';
  btnFav.addEventListener('click', toggleFav);
  document.body.appendChild(btnFav);

  btnNote = document.createElement('button');
  btnNote.id = 'btn-note';
  btnNote.textContent = '✎';
  btnNote.setAttribute('aria-label', '编辑病例笔记');
  btnNote.addEventListener('click', openNote);
  document.body.appendChild(btnNote);

  // 笔记抽屉：结构与「病例信息」面板保持一致，手机上从底部弹出
  noteBackdrop = document.createElement('div');
  noteBackdrop.id = 'note-backdrop';
  noteBackdrop.className = 'hidden';
  noteBackdrop.innerHTML = `
    <div id="note-sheet" role="dialog" aria-modal="true" aria-label="病例笔记">
      <div id="note-head"><span>病例笔记</span>
        <button id="note-close" aria-label="关闭笔记">✕</button></div>
      <div id="note-body">
        <textarea id="note-area" aria-label="病例笔记内容"
          placeholder="一句话记下这例的关键点、易错处或随访计划…"></textarea>
        <div id="note-foot"><span>只存本机，不上传</span><span id="note-status"></span></div>
      </div>
    </div>`;
  document.body.appendChild(noteBackdrop);

  noteArea = noteBackdrop.querySelector('#note-area');
  noteStatus = noteBackdrop.querySelector('#note-status');

  noteBackdrop.querySelector('#note-close').addEventListener('click', closeNote);
  // 点遮罩空白处关闭；点抽屉内部不关闭
  noteBackdrop.addEventListener('click', (e) => { if (e.target === noteBackdrop) closeNote(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !noteBackdrop.classList.contains('hidden')) closeNote();
  });

  // 输入防抖：停手 500ms 再落盘，避免每个字都写一次 localStorage
  noteArea.addEventListener('input', () => {
    noteStatus.textContent = '正在保存…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(saveNote, 500);
  });

  // 另一个标签页改了收藏/笔记时，本页同步刷新星标
  window.addEventListener('storage', (e) => {
    if (e.key === PersonStore.KEY) {
      marks = PersonStore.load().items;
      syncFavButton();
    }
  });

  syncFavButton();
  recordRecent();
}

init();
