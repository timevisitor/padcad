/** Shared, serializable definitions for feature patterns and mirrors. */
function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}必须是有限数值`);
  return value;
}

function vector(value, label, direction = false) {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label}需要三个坐标`);
  const result = value.map((v) => finite(v, label));
  if (!direction) return result;
  const scale = Math.max(...result.map(Math.abs));
  if (scale === 0) throw new Error(`${label}不能为零向量`);
  const scaled = result.map((v) => v / scale);
  const length = Math.hypot(...scaled);
  return scaled.map((v) => v / length);
}

function boundsOf(shape) {
  if (!shape || typeof shape.clone !== "function") throw new Error("阵列或镜像需要已有的实体");
  try {
    const bb = shape.boundingBox;
    const center = vector(bb.center, "模型中心");
    const size = [bb.width, bb.height, bb.depth].map((n) => finite(n, "模型尺寸"));
    return { center, size };
  } catch (_) { throw new Error("阵列或镜像的模型实体已失效"); }
}

/**
 * Materialize defaults before a new/edit operation is saved. Old files can omit
 * these fields: replay then uses their original bounding-box defaults each time.
 * bbox mirror modes remain associated with the model boundary; offset is fixed.
 */
export function normalizePatternOp(op, baseShape) {
  if (!op || !["pattern", "mirror"].includes(op.type)) throw new Error("操作必须是阵列或镜像");
  if (!Number.isSafeInteger(op.source) || op.source < 0) throw new Error("源特征索引无效");
  const operation = op.operation === undefined ? "fuse" : op.operation;
  if (!["fuse", "cut"].includes(operation)) throw new Error("阵列或镜像的布尔操作无效");
  const bounds = boundsOf(baseShape);
  const normalized = { ...op, operation };
  if (op.type === "mirror") {
    const plane = op.plane;
    if (!["XY", "XZ", "YZ"].includes(plane)) throw new Error("镜像平面只能是 XY / XZ / YZ");
    const axis = plane === "YZ" ? 0 : plane === "XZ" ? 1 : 2;
    const legacyOff = op.off === undefined ? null : vector(op.off, "旧镜像位置");
    const at = op.at === undefined ? (legacyOff?.[axis] ? "offset" : "world") : op.at;
    if (!["world", "offset", "bboxMin", "bboxMax"].includes(at)) throw new Error("镜像位置类型无效");
    if (op.offset !== undefined) finite(op.offset, "镜面偏移");
    let offset = 0;
    if (at === "offset") offset = op.offset === undefined ? (legacyOff?.[axis] ?? 0) / 2 : op.offset;
    if (at === "bboxMin" || at === "bboxMax") {
      offset = bounds.center[axis] + (at === "bboxMin" ? -1 : 1) * bounds.size[axis] / 2;
    }
    // New definitions need only a signed plane offset, never a post-mirror translation.
    delete normalized.off;
    return { ...normalized, plane, at, offset };
  }

  const count = finite(op.count, "阵列数量");
  if (!Number.isInteger(count) || count < 2 || count > 64) throw new Error("阵列数量必须是 2 到 64 的整数");
  const kind = op.kind === undefined ? "linear" : op.kind;
  if (!["linear", "circular"].includes(kind)) throw new Error("阵列类型无效");
  if (kind === "linear") {
    const direction = vector(op.direction === undefined ? [1, 0, 0] : op.direction, "阵列方向", true);
    const spacing = op.spacing === undefined ? Math.max(bounds.size[0] / (count - 1), 1) : finite(op.spacing, "阵列间距");
    if (spacing <= 0) throw new Error("阵列间距必须大于 0");
    return { ...normalized, kind, count, direction, spacing };
  }
  const axisPoint = vector(op.axisPoint === undefined ? bounds.center : op.axisPoint, "旋转轴原点");
  const axisDir = vector(op.axisDir === undefined ? [0, 0, 1] : op.axisDir, "旋转轴方向", true);
  const angle = op.angle === undefined ? 360 : finite(op.angle, "阵列角度");
  if (angle <= 0 || angle > 360) throw new Error("阵列角度必须大于 0 且不超过 360 度");
  return { ...normalized, kind, count, axisPoint, axisDir, angle };
}

/** Return the cumulative model and only the newly copied tool material. */
export function applyPatternOp(baseShape, sourceTool, definition) {
  const op = normalizePatternOp(definition, baseShape);
  if (!sourceTool || typeof sourceTool.clone !== "function") throw new Error("找不到有效的源特征实体");
  // Access before starting transformations so deleted source objects fail explicitly.
  try { vector(sourceTool.boundingBox.center, "源特征中心"); }
  catch (_) { throw new Error("源特征实体已失效，请重新选择"); }
  let tool = null;
  try {
    if (op.type === "mirror") {
      tool = sourceTool.clone().mirror(op.plane);
      if (op.offset) {
        const delta = [0, 0, 0];
        delta[op.plane === "YZ" ? 0 : op.plane === "XZ" ? 1 : 2] = 2 * op.offset;
        tool = tool.translate(delta);
      }
    } else {
      const step = op.kind === "circular" ? op.angle / (op.angle === 360 ? op.count : op.count - 1) : null;
      for (let i = 1; i < op.count; i++) {
        const copy = op.kind === "linear"
          ? sourceTool.clone().translate(op.direction.map((v) => v * op.spacing * i))
          : sourceTool.clone().rotate(step * i, op.axisPoint, op.axisDir);
        tool = tool ? tool.fuse(copy) : copy;
      }
    }
    const shape = baseShape.clone()[op.operation](tool);
    return { shape, tool, op };
  } catch (e) {
    throw new Error(`${op.type === "mirror" ? "镜像" : "阵列"}计算失败：${e?.message || e}`);
  }
}
