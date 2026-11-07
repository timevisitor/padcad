import * as THREE from "three";
import { resolvePlane } from "./replay.js";
import { solveSketch } from "./solver.js";
import { normalizePatternOp } from "./pattern.js";

const v3 = a => new THREE.Vector3(...a);
const finiteVector = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const tolerance = radius => Math.max(1e-5, radius * 1e-6);

/** Exact trimmed cylinder geometry; range is measured from axisPoint along axis.
 * Does not consume the input face. All returned values are plain data.
 */
export function readCylinderFace(face) {
  const owned = [];
  const keep = value => { owned.push(value); return value; };
  try {
    const surface = keep(face.surface);
    if (surface.surfaceType !== "CYLINDRE") return null;
    const cylinder = keep(surface.wrapped.Cylinder());
    const location = keep(cylinder.Location());
    const ax = keep(cylinder.Axis());
    const direction = keep(ax.Direction());
    const radius = cylinder.Radius();
    const axisPoint = [location.X(), location.Y(), location.Z()];
    const axis = [direction.X(), direction.Y(), direction.Z()];
    const bounds = face.UVBounds;
    const range = [bounds.vMin, bounds.vMax];
    if (!finiteVector(axisPoint) || !finiteVector(axis) || !Number.isFinite(radius) || radius <= 0
      || !range.every(Number.isFinite) || range[1] <= range[0]) return null;
    // BRepAdaptor_Surface(..., false) has infinite V limits. Face.UVBounds is trimmed.
    const ends = range.map(t => axisPoint.map((x, i) => x + t * axis[i]));
    const point = keep(face.pointOnSurface(.371, .513));
    const normal = keep(face.normalAt(point));
    const radial = v3(point.toTuple()).sub(v3(axisPoint));
    radial.addScaledVector(v3(axis), -radial.dot(v3(axis)));
    const alignment = radial.normalize().dot(v3(normal.toTuple()).normalize());
    if (!Number.isFinite(alignment) || Math.abs(alignment) < .99) return null;
    return { kind: "cylinder", radius, axis, axisPoint, ends, range, polarity: alignment > 0 ? 1 : -1 };
  } catch (_) { return null; }
  finally { owned.reverse().forEach(value => { try { value.delete(); } catch (_) {} }); }
}

function cylindersOf(shape) {
  if (!shape) return [];
  const faces = shape.faces;
  try { return faces.map(readCylinderFace).filter(Boolean); }
  finally { faces.forEach(face => face.delete()); }
}

function sameCylinder(a, b) {
  const tol = tolerance(Math.max(a.radius, b.radius));
  return a.polarity === b.polarity && Math.abs(a.radius - b.radius) <= tol
    && Math.abs(v3(a.axis).dot(v3(b.axis))) > 1 - 1e-8
    && v3(a.axisPoint).sub(v3(b.axisPoint)).cross(v3(b.axis)).length() <= tol;
}

function coversFace(candidate, face) {
  if (!sameCylinder(candidate, face)) return false;
  const tol = tolerance(face.radius);
  const projection = p => v3(p).sub(v3(candidate.axisPoint)).dot(v3(candidate.axis));
  const wanted = face.ends.map(projection).sort((a, b) => a - b);
  const available = candidate.ends.map(projection).sort((a, b) => a - b);
  return wanted[0] >= available[0] - tol && wanted[1] <= available[1] + tol;
}

function transformed(candidate, point, direction) {
  return { ...candidate, axisPoint: point(candidate.axisPoint), axis: direction(candidate.axis),
    ends: candidate.ends.map(point) };
}

function moveTransform(op, before) {
  const angle = (Number(op.rot) || 0) * Math.PI / 180;
  const pivot = op.pivot === "center" ? v3(before.boundingBox.center) : new THREE.Vector3();
  const axis = v3(op.axis === "X" ? [1, 0, 0] : op.axis === "Y" ? [0, 1, 0] : [0, 0, 1]);
  const delta = new THREE.Vector3(Number(op.dx) || 0, Number(op.dy) || 0, Number(op.dz) || 0);
  return candidate => transformed(candidate,
    p => v3(p).sub(pivot).applyAxisAngle(axis, angle).add(pivot).add(delta).toArray(),
    d => v3(d).applyAxisAngle(axis, angle).toArray());
}

function patternCopies(source, op, before) {
  const normalized = normalizePatternOp(op, before);
  const copies = [];
  const polarity = normalized.operation === "cut" ? -1 : 1;
  if (normalized.type === "mirror") {
    const index = { YZ: 0, XZ: 1, XY: 2 }[normalized.plane];
    const point = p => p.map((v, i) => i === index ? 2 * normalized.offset - v : v);
    const direction = d => d.map((v, i) => i === index ? -v : v);
    return source.map(c => ({ ...transformed(c, point, direction), polarity }));
  }
  for (let index = 1; index < normalized.count; index++) {
    if (normalized.kind === "linear") {
      const delta = v3(normalized.direction).multiplyScalar(normalized.spacing * index);
      copies.push(...source.map(c => ({ ...transformed(c, p => v3(p).add(delta).toArray(), d => [...d]), polarity })));
    } else {
      const step = normalized.angle / (normalized.angle === 360 ? normalized.count : normalized.count - 1);
      const angle = step * index * Math.PI / 180;
      const pivot = v3(normalized.axisPoint), axis = v3(normalized.axisDir);
      copies.push(...source.map(c => ({ ...transformed(c,
        p => v3(p).sub(pivot).applyAxisAngle(axis, angle).add(pivot).toArray(),
        d => v3(d).applyAxisAngle(axis, angle).toArray()), polarity })));
    }
  }
  return copies;
}

function extrusionCandidates(op, index, before) {
  const plane = resolvePlane(before, op.plane);
  try {
    const entities = structuredClone(op.entities);
    if (!solveSketch(entities, structuredClone(op.constraints === undefined ? [] : op.constraints)).ok) return [];
    const depth = op.depth, grow = Math.abs(op.grow ?? .002);
    if (!Number.isFinite(depth) || depth === 0 || !Number.isFinite(grow)) return [];
    const axis = plane.normal.clone().normalize();
    const x = plane.xDir.clone().normalize();
    const y = new THREE.Vector3().crossVectors(axis, x).normalize();
    const selected = Array.isArray(op.selected) ? op.selected : [];
    return entities.flatMap((entity, sub) => {
      if (entity.kind !== "circle" || entity.ref || (selected.length && !selected.includes(sub))) return [];
      const center = plane.origin.clone().addScaledVector(x, entity.c[0]).addScaledVector(y, entity.c[1]);
      const ends = [-Math.sign(depth) * grow, depth].map(t => center.clone().addScaledVector(axis, t).toArray());
      return [{ kind: "cylinder", radius: entity.r, axis: axis.toArray(), axisPoint: center.toArray(), ends,
        polarity: depth > 0 ? 1 : -1,
        driver: { i: index, kind: "sketchCircle", sub, key: "r", value: entity.r,
          label: `第 ${index + 1} 步草图里的圆（R${entity.r.toFixed(2)}）` } }];
    });
  } finally { plane.occtPlane?.delete(); }
}

/** Return a unique, geometrically proven radius driver, or [] without guessing.
 * Snapshots must correspond to the supplied history definitions. Raw feature tools
 * intentionally retain their original coordinates, matching replay's pattern semantics.
 */
export function findSurfaceDrivers({ history, hIndex, shape, faceId }) {
  if (!Array.isArray(history) || !Number.isInteger(hIndex) || hIndex < 0 || hIndex >= history.length || !shape) return [];
  try {
    const faces = shape.faces;
    let selected;
    try { selected = readCylinderFace(faces.find(face => face.hashCode === faceId)); }
    finally { faces.forEach(face => face.delete()); }
    if (!selected) return [];
    let visible = [];
    const tools = [];
    for (let index = 0; index <= hIndex; index++) {
      const step = history[index], op = step?.op;
      tools[index] = [];
      if (step?.suppressed) continue;
      if (!op) return [];
      const before = index > 0 ? history[index - 1]?.shape : null;
      if (op.type === "base") {
        const radius = op.holeRadius ?? 6;
        if (!Number.isFinite(radius) || radius <= 0) return [];
        visible.push({ kind: "cylinder", radius, axis: [0, 0, 1], axisPoint: [0, 0, 0], ends: [[0, 0, 0], [0, 0, 8]], polarity: -1,
          driver: { i: index, kind: "baseHole", key: "holeRadius", value: radius, label: `第 ${index + 1} 步初始底板中孔（R${radius.toFixed(2)}）` } });
      } else if (op.type === "extrude") {
        const generated = extrusionCandidates(op, index, before);
        visible.push(...generated);
        tools[index] = generated;
      } else if (op.type === "move3d") {
        if (!before) return [];
        visible = visible.map(moveTransform(op, before));
      } else if (op.type === "pattern" || op.type === "mirror") {
        if (!Number.isInteger(op.source) || op.source >= index || !tools[op.source]?.length) continue;
        const generated = patternCopies(tools[op.source], op, before);
        visible.push(...generated);
        tools[index] = generated;
      } else if (op.type === "fillet") {
        // A fillet can also be cylindrical. Require a newly generated analytic
        // cylinder, rather than attributing every same-radius cylinder to this step.
        const prior = cylindersOf(before);
        for (const face of cylindersOf(step.shape)) {
          if (Math.abs(face.radius - op.radius) > tolerance(face.radius) || prior.some(old => sameCylinder(face, old))) continue;
          visible.push({ ...face, driver: { i: index, kind: "fillet", key: "radius", value: op.radius,
            label: `第 ${index + 1} 步的圆角（R${op.radius}）` } });
        }
      }
    }
    const matches = new Map();
    for (const candidate of visible) {
      if (!coversFace(candidate, selected)) continue;
      const driver = candidate.driver;
      matches.set(`${driver.i}:${driver.kind}:${driver.sub ?? ""}`, driver);
    }
    return matches.size === 1 ? [...matches.values()] : [];
  } catch (_) { return []; }
}
