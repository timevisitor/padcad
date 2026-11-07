// Cache identity is local to this session and never saved in the project file.
const snapshots = new WeakMap();
const definition = row => JSON.stringify([row.op, !!row.suppressed]);

export function markSnapshot(row) {
  snapshots.set(row, { shape: row.shape, definition: definition(row) });
}

export function canReuseSnapshot(row) {
  const saved = row && snapshots.get(row);
  return !!saved && saved.shape === row.shape && saved.definition === definition(row);
}
