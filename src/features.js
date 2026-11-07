/**
 * 新特征层：旋转 / 扫掠 / 放样 / 阵列 / 镜像
 *
 * 这些能力其实一直躺在 replicad 里（revolve / genericSweep / loft / mirror），
 * 只是之前没接出来。本模块把它们包成与前面推拉/圆角一致的形状，
 * 供 UI 与参数化重放调用。
 *
 * 几个实测确认的 API 用法（见 probe-revolve.mjs / probe-features.mjs）：
 *   旋转  drawing.revolve([0,1], { origin:[ax,0], angle }) —— 轴在**草图平面内**用 2D 表示
 *         轮廓贴轴 → 实心回转体；离轴 → 管状；**跨过轴 → OCCT 直接抛异常**（不是静默出错）
 *   扫掠  genericSweep(profileWire, Sketcher(...).xxx().done().wire, cfg)
 *         脊柱必须用 `.done().wire` —— 不调 done() 拿不到 wire（`.wire` 是 undefined）
 *   放样  loft([wireA, wireB, ...])   —— `wire.loftWith()` 这个写法不存在
 *   阵列  translate / rotate 循环 + fuse
 *   镜像  shape.mirror("XY"|"YZ"|"ZX")
 */
import {
  drawRectangle, drawCircle, draw, makeLine, genericSweep, loft as ocLoft, measureVolume, Sketcher,
} from "replicad";

/** 把角度规整到 (0, 360] */
function normAngle(a) {
  let x = Number(a);
  if (!isFinite(x)) x = 360;
  x = ((x % 360) + 360) % 360;
  return x === 0 ? 360 : x;
}

/**
 * 旋转凸台。
 * @param sketch Drawing（已 sketchOnPlane 到目标平面）
 * @param axisLine  旋转轴，形如 [[x1,y1],[x2,y2]]（**草图平面内的 2D 坐标**）
 * @param angle     角度（度），默认 360
 */
export function revolveDrawing(sketch, axisLine, angle = 360) {
  if (!sketch || !axisLine) throw new Error("旋转需要草图和旋转轴");
  const [p1, p2] = axisLine;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  if (Math.hypot(dx, dy) < 1e-9) throw new Error("旋转轴的两个点重合了");
  // 轴的 2D 方向 + 轴上一个点
  const L = Math.hypot(dx, dy);
  const dir = [dx / L, dy / L];
  const a = normAngle(angle);
  try {
    return sketch.revolve(dir, { origin: p1, angle: a });
  } catch (e) {
    // 轮廓跨过旋转轴是最常见的失败原因，给一句人话
    throw new Error("旋转失败：轮廓不能跨过旋转轴（要完全在轴的一侧，可以贴轴）。请检查草图与轴的位置关系。");
  }
}

/**
 * 扫掠（实用模式）：截面在草图平面内，路径沿**草图法向**走一段长度。
 *
 * 为什么这样设计：扫掠的几何前提是「路径垂直于截面平面」，而草图里的所有轮廓
 * 都躺**在同一个平面**上 —— 想在同草图里画一条垂直的路径是不可能的。
 * SolidWorks 的做法是让你在另一个平面上再画一条路径，那需要多草图支持；
 * 平板上更省事的是：**画好截面，给出长度，沿法向扫出去**
 * （本质是把"拉伸"升级成"沿任意曲线扫掠"的第一步）。
 *
 * @param profileDrawing 截面（Drawing/Sketch，任意有 wire 的对象）
 * @param length         路径长度
 * @param origin3D       路径起点（世界坐标，一般取草图原点）
 * @param normal3D       路径方向（世界坐标，一般取草图法向）
 */
export function sweepNormal(profileDrawing, length, origin3D, normal3D) {
  const pw = profileDrawing.wire || profileDrawing;
  if (!pw) throw new Error("截面取不到轮廓线");
  const L = Math.abs(Number(length) || 0);
  if (L < 1e-6) throw new Error("扫掠长度要大于 0");
  if (!origin3D || !normal3D) throw new Error("扫掠缺少起点或方向");
  // 造一条沿 +Z 的直线（XZ 平面上的竖线），再把它转到法向方向、移到起点
  const sk = new Sketcher("XZ").movePointerTo([0, 0]).vLine(L, false);
  const wire0 = sk.done().wire;
  const n = [normal3D[0], normal3D[1], normal3D[2]];
  const nl = Math.hypot(...n);
  if (!Number.isFinite(nl) || nl < 1e-9 || !origin3D.every(Number.isFinite)) throw new Error("扫掠起点或方向无效");
  const u = n.map((v) => v / nl);
  // 世界 +Z 转到 u：绕轴 = z×u，角 = acos(z·u)
  const z = [0, 0, 1];
  const dotv = Math.max(-1, Math.min(1, z[0] * u[0] + z[1] * u[1] + z[2] * u[2]));
  let wire1 = wire0;
  if (dotv < 0.999999) {
    const ax = [z[1] * u[2] - z[2] * u[1], z[2] * u[0] - z[0] * u[2], z[0] * u[1] - z[1] * u[0]];
    const al = Math.hypot(...ax);
    if (al > 1e-9) {
      const ang = (Math.acos(dotv) * 180) / Math.PI;
      const axis = ax.map((v) => v / al);
      wire1 = wire0.rotate(ang, [0, 0, 0], axis);
    } else if (dotv < 0) {
      // +Z 与 -Z 反向时叉积为零，仍然需要转 180°。
      wire1 = wire0.rotate(180, [0, 0, 0], [1, 0, 0]);
    }
  }
  const spine = wire1.translate([origin3D[0], origin3D[1], origin3D[2]]);
  try {
    return genericSweep(pw, spine, { forceProfileSpineOthogonality: true });
  } catch (e) {
    throw new Error("扫掠失败：截面与路径的位置不合适（截面需完整落在路径起点所在的平面上）");
  }
}

/** 扫掠：轮廓沿路径。轮廓/路径都传 replice 对象（两个都在同一平面时通常不成立） */
export function sweepAlong(profileDrawing, spineSketch, opts = {}) {
  if (!profileDrawing || !spineSketch) throw new Error("扫掠需要轮廓和路径");
  const pw = profileDrawing.wire || profileDrawing;
  // 脊柱要 .done() 之后才有 wire（不调的话是 undefined）
  const spine = spineSketch.wire || (spineSketch.done ? spineSketch.done().wire : null);
  if (!spine) throw new Error("扫掠路径取不到（需要一条开放的折线作为路径）");
  try {
    return genericSweep(pw, spine, {
      forceProfileSpineOthogonality: true,
      ...opts,
    });
  } catch (e) {
    throw new Error("扫掠失败：轮廓与路径的位置可能不合适（轮廓平面最好垂直于路径起点）");
  }
}

/** 放样：若干个截面 wire 依次过渡 */
export function loftWires(wires) {
  const list = (wires || []).filter(Boolean);
  if (list.length < 2) throw new Error("放样至少要两个截面");
  let solid;
  try {
    solid = ocLoft(list);
  } catch (e) {
    throw new Error("放样失败：各截面的方向要一致（比如都用矩形、都同向画）");
  }
  const volume = volumeOf(solid);
  if (!Number.isFinite(volume) || volume <= 0) {
    solid.delete();
    throw new Error("放样失败：截面没有形成有效体积，请使用位于不同平面的闭合截面");
  }
  return solid;
}

/**
 * 线性阵列：把一个实体沿方向排 count 份，间距 spacing。
 * 返回新实体（不含原体）。
 *
 * 注意：replicad 的 translate/rotate 会**消费掉原对象**（第二次调用就报
 * "This object has been deleted"），所以每次变换前都要 clone()。
 */
export function linearPattern(shape, dir = [1, 0, 0], count = 3, spacing = 20) {
  const n = Math.max(2, Math.round(count));
  const d = [...dir];
  const L = Math.hypot(...d) || 1;
  const u = d.map((v) => v / L);
  let acc = null;
  for (let i = 1; i < n; i++) {
    const t = shape.clone().translate(u[0] * spacing * i, u[1] * spacing * i, u[2] * spacing * i);
    acc = acc ? acc.fuse(t) : t;
  }
  return acc || shape.clone();
}

/**
 * 圆周阵列：绕轴均匀排 count 份。
 * @param axisPoint 轴上一点 [x,y,z]
 * @param axisDir   轴方向
 */
export function circularPattern(shape, axisPoint = [0, 0, 0], axisDir = [0, 0, 1], count = 4, full = true) {
  const n = Math.max(2, Math.round(count));
  const step = full ? 360 / n : 360 / (n - 1 || 1);
  let acc = null;
  for (let i = 1; i < n; i++) {
    const t = shape.clone().rotate(step * i, axisPoint, axisDir);
    acc = acc ? acc.fuse(t) : t;
  }
  return acc || shape.clone();
}

/**
 * 镜像。plane 用 "XY" / "YZ" / "ZX"。
 *
 * 注意：mirror 同样会**消费掉原对象**（之后再用它就报 "object has been deleted"），
 * 所以先 clone 一份再镜像，原体保持可用。
 */
export function mirrorOf(shape, plane = "YZ") {
  const p = String(plane).toUpperCase();
  const ok = ["XY", "YX", "XZ", "ZX", "YZ", "ZY"];
  if (!ok.includes(p)) throw new Error("镜像平面只能是 XY / XZ / YZ（正反写都行）");
  // 归一化成 OCCT 认的三种写法之一
  const canon = { XY: "XY", YX: "XY", XZ: "XZ", ZX: "XZ", YZ: "YZ", ZY: "YZ" }[p];
  return shape.clone().mirror(canon);
}

/** 体积（用来对账；非闭合体返回 0） */
export function volumeOf(shape) {
  try { return measureVolume(shape); } catch (_) { return 0; }
}

// ------------------------------------------------------------------ 旋转轴的正交化
/**
 * 从"草图里的一条线"得到旋转轴（草图平面 2D 坐标）。
 * 允许用户直接给两个点，也允许给 {a:[x,y], b:[x,y]}。
 */
export function axisFromLine(line) {
  if (!line) return null;
  if (Array.isArray(line) && line.length === 2 && Array.isArray(line[0])) return [line[0], line[1]];
  if (line.a && line.b) return [line.a, line.b];
  return null;
}
