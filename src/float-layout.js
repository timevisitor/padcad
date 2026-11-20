/**
 * 浮动界面的纯几何计算（不碰 DOM，可直接单测）。
 *
 * 平板 UI 的一切「浮在哪」都由这里算：
 *  · radialLayout  长按径向菜单（marking menu）的圆环排布 + 贴边夹取
 *  · placeCard     选中面小卡这类「贴着焦点、又要躲开尺寸手柄」的浮卡
 *
 * 为什么要纯函数：这两个东西最容易出「贴边就跑出屏」「盖住手柄」这类 bug，
 * 而这些 bug 在真机上才看得见。抽成纯函数后可以在 node 里穷举边界值。
 */

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 两个矩形的重叠面积（不相交为 0）。矩形 {x,y,w,h} 都用左上角 + 宽高。 */
export function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function insideBox(box, vp, margin) {
  return box.x >= margin - 1e-6
    && box.y >= margin - 1e-6
    && box.x + box.w <= vp.w - margin + 1e-6
    && box.y + box.h <= vp.h - margin + 1e-6;
}

/**
 * 径向菜单排布。
 *
 * 关键约定（验收要看）：返回的 `box` 是一个**以圆心为中心的正方形**，
 * 所以菜单容器的 rect 中心 == 圆心 == 手指位置（没被夹取时）。
 * 如果按「所有按钮的外接矩形」当容器，3 项时容器中心会偏 0.25R，验收会误判。
 *
 * @param {{x:number,y:number,count:number,viewport:{w:number,h:number},
 *          radius?:number,itemSize?:number,margin?:number,startAngle?:number}} o
 * @returns {{center:{x:number,y:number},radius:number,itemSize:number,
 *            box:{x:number,y:number,w:number,h:number},
 *            items:{angle:number,x:number,y:number}[],
 *            fingerDist:number}}
 */
export function radialLayout({ x, y, count, viewport, radius = 88, itemSize = 56, margin = 8, startAngle = -Math.PI / 2 }) {
  const n = Math.max(0, Math.floor(count) || 0);
  const half = itemSize / 2;
  // 项多的时候圆环要放大，否则相邻按钮会挤在一起（每项至少 itemSize+6 的弧长）
  const need = n <= 1 ? 0 : (n * (itemSize + 6)) / (2 * Math.PI);
  const R = Math.max(radius, need);
  const vp = viewport || { w: 360, h: 640 };
  // 容器是以圆心为中心的正方形；半径 + 半个按钮 = 半边长
  const side = 2 * (R + half);
  let cx = x, cy = y;
  // 先按正方形夹进视口
  const lo = margin;
  if (side <= vp.w - 2 * margin) cx = clamp(cx, lo + side / 2, vp.w - lo - side / 2);
  else cx = vp.w / 2;
  if (side <= vp.h - 2 * margin) cy = clamp(cy, lo + side / 2, vp.h - lo - side / 2);
  else cy = vp.h / 2;

  const items = [];
  for (let i = 0; i < n; i++) {
    const angle = startAngle + (i * 2 * Math.PI) / n;
    items.push({
      angle,
      x: cx + Math.cos(angle) * R,
      y: cy + Math.sin(angle) * R,
    });
  }
  return {
    center: { x: cx, y: cy },
    radius: R,
    itemSize,
    box: { x: cx - side / 2, y: cy - side / 2, w: side, h: side },
    items,
    fingerDist: Math.hypot(cx - x, cy - y),
  };
}

/**
 * 把一个浮卡放到锚点旁边，不越视口、不盖住 avoid 里的东西（尺寸手柄、顶部浮块…）、
 * 也不许**盖住锚点本身**（锚点＝手指刚落下的位置／被选中的那个面，
 * 盖住它就等于把用户刚点的东西藏起来 —— 装配的配合菜单实测就是这样：菜单被夹到顶边后
 * 整个压在第二个落点上，看着像"点了没反应"）。
 *
 * 打分 = 与锚点的距离 + 惩罚（越界面积 / 遮住别人面积 / 盖住锚点）。
 * 所以只要存在「完全合规」的位置，一定选得到它；全都不合规时退回重叠最少的位置。
 *
 * @param {{anchor:{x:number,y:number}, size:{w:number,h:number},
 *          viewport:{w:number,h:number}, avoid?:{x:number,y:number,w:number,h:number}[],
 *          avoidPoints?:{x:number,y:number}[], gap?:number, margin?:number}} o
 *        avoidPoints 默认 [anchor]：这些点都不许落进卡片矩形里
 * @returns {{x:number,y:number,side:string,overlap:number,inside:boolean,coversPoint:boolean}}
 */
export function placeCard({ anchor, size, viewport, avoid = [], avoidPoints = null, gap = 12, margin = 8 }) {
  const vp = viewport || { w: 360, h: 640 };
  const { w, h } = size;
  const ax = anchor.x;
  const ay = anchor.y;
  const points = (avoidPoints || [{ x: ax, y: ay }]).filter((p) => p && isFinite(p.x) && isFinite(p.y));
  const candidates = [
    { side: "right", x: ax + gap, y: ay - h / 2 },
    { side: "left", x: ax - gap - w, y: ay - h / 2 },
    { side: "above", x: ax - w / 2, y: ay - gap - h },
    { side: "below", x: ax - w / 2, y: ay + gap },
    { side: "right-above", x: ax + gap * 0.8, y: ay - gap * 0.8 - h },
    { side: "right-below", x: ax + gap * 0.8, y: ay + gap * 0.8 },
    { side: "left-above", x: ax - gap * 0.8 - w, y: ay - gap * 0.8 - h },
    { side: "left-below", x: ax - gap * 0.8 - w, y: ay + gap * 0.8 },
  ];

  let best = null;
  for (const c of candidates) {
    // 先夹进视口（宁愿挪一点，也不许出屏）
    const box = {
      x: clamp(c.x, margin, Math.max(margin, vp.w - w - margin)),
      y: clamp(c.y, margin, Math.max(margin, vp.h - h - margin)),
      w,
      h,
    };
    let overlap = 0;
    for (const a of avoid) if (a) overlap += overlapArea(box, a);
    /*
     * 盖住锚点/被选对象：这是"看不见自己刚点了什么"的直接原因，
     * 惩罚必须比距离差大一个量级（1e6 ≫ 任何距离 + 面积项），
     * 凡是存在不盖住锚点的候选就一律优先它。
     */
    let coversPoint = false;
    for (const p of points) {
      if (p.x > box.x && p.x < box.x + w && p.y > box.y && p.y < box.y + h) { coversPoint = true; break; }
    }
    const dist = Math.hypot(box.x + w / 2 - ax, box.y + h / 2 - ay);
    // 重叠的惩罚必须远大于距离差：宁可放远一点，也不能盖住尺寸手柄
    const score = dist + overlap * 0.6 + (coversPoint ? 1e6 : 0);
    if (!best || score < best.score) best = { ...box, side: c.side, overlap, score, coversPoint, inside: insideBox(box, vp, margin) };
  }
  return { x: best.x, y: best.y, side: best.side, overlap: best.overlap, inside: best.inside, coversPoint: !!best.coversPoint };
}

/**
 * 大浮层（配合菜单这类"又高又宽、旁边还有模型"的卡）的定位：**扫描式**选位。
 *
 * 为什么不能只靠 placeCard 的 8 个相对位置：那些候选全都贴着锚点，最多差 14px；
 * 而被选中的面可能铺满锚点周围一两百像素（60×40 的板从下往上看，底面投影就是一大块），
 * 8 个位置全压在面上，评分只能"选个压得少的" —— 实测 30259px² 压在第二个面上。
 *
 * 这里在视口里按 step 网格扫一遍，先排除"压到 avoid / 盖住锚点"的位置，
 * 再在剩下的里面取离锚点最近的。有合规位置就一定选得到。
 *
 * @param {{anchor:{x:number,y:number}, size:{w:number,h:number}, viewport:{w:number,h:number},
 *          avoid?:{x:number,y:number,w:number,h:number}[], avoidPoints?:{x:number,y:number}[],
 *          margin?:number, step?:number}} o
 * @returns {{x:number,y:number,side:string,overlap:number,inside:boolean,coversPoint:boolean,scanned:number}}
 */
export function placeCardScan({ anchor, size, viewport, avoid = [], avoidPoints = null, margin = 8, step = 16 }) {
  const vp = viewport || { w: 360, h: 640 };
  const { w, h } = size;
  const ax = anchor.x, ay = anchor.y;
  const points = (avoidPoints || [{ x: ax, y: ay }]).filter((p) => p && isFinite(p.x) && isFinite(p.y));
  const maxX = Math.max(margin, vp.w - w - margin);
  const maxY = Math.max(margin, vp.h - h - margin);
  const x0 = Math.min(margin, maxX);
  const y0 = Math.min(margin, maxY);
  const xs = [];
  for (let x = x0; x <= maxX + 0.5; x += step) xs.push(Math.round(x));
  if (xs[xs.length - 1] !== maxX) xs.push(Math.round(maxX));
  const ys = [];
  for (let y = y0; y <= maxY + 0.5; y += step) ys.push(Math.round(y));
  if (ys[ys.length - 1] !== maxY) ys.push(Math.round(maxY));

  let best = null, scanned = 0;
  for (const y of ys) {
    for (const x of xs) {
      const box = { x, y, w, h };
      scanned++;
      let overlap = 0;
      for (const a of avoid) if (a) overlap += overlapArea(box, a);
      let coversPoint = false;
      for (const p of points) {
        if (p.x > box.x && p.x < box.x + w && p.y > box.y && p.y < box.y + h) { coversPoint = true; break; }
      }
      const dist = Math.hypot(x + w / 2 - ax, y + h / 2 - ay);
      const score = dist + overlap * 0.6 + (coversPoint ? 1e6 : 0);
      if (!best || score < best.score) best = { ...box, overlap, score, coversPoint, inside: insideBox(box, vp, margin) };
    }
  }
  return { x: best.x, y: best.y, side: "scan", overlap: best.overlap, inside: best.inside, coversPoint: !!best.coversPoint, scanned };
}

/**
 * 竖向工具坞的尺寸：给定按钮数与当前可用高度，算按钮边长与总高。
 * 坞过高时优先压缩到下限（48），再压不住就靠滚动 —— 绝不越过上下角保留区。
 */
export function dockMetrics({ count, viewport, reservedTop = 64, reservedBottom = 64, max = 52, min = 48, gap = 8 }) {
  const n = Math.max(0, Math.floor(count) || 0);
  if (!n) return { size: max, gap, height: 0, overflow: false };
  const avail = Math.max(0, (viewport?.h || 640) - reservedTop - reservedBottom);
  let size = max;
  let height = n * size + (n - 1) * gap;
  while (height > avail && size > min) {
    size -= 1;
    height = n * size + (n - 1) * gap;
  }
  return { size, gap, height, overflow: height > avail };
}
