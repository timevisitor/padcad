import { escapeHTML } from "./project.js";
import "./pattern-panel.css";

const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1], "-X": [-1, 0, 0], "-Y": [0, -1, 0], "-Z": [0, 0, -1] };
const options = (entries, selected) => entries.map(([v, label]) => `<option value="${escapeHTML(v)}"${String(v) === String(selected) ? " selected" : ""}>${escapeHTML(label)}</option>`).join("");
const number = (id, label, value, extra = "", integer = false) => `<label class="pt-field">${label}<input id="${id}" type="number" inputmode="${integer ? "numeric" : "decimal"}" step="${integer ? "1" : "any"}" required data-label="${escapeHTML(label)}" value="${escapeHTML(value)}" ${extra}></label>`;
const row = (id, label, entries, selected) => `<label class="pt-field">${label}<select id="${id}" required>${options(entries, selected)}</select></label>`;
const vecKey = (v) => Object.keys(AXES).find((key) => v.every((x, i) => Math.abs(x - AXES[key][i]) < 1e-8)) || "custom";

export function createPatternPanel({ onPreview, onApply, onCancel, onChange }) {
  const panel = document.createElement("section");
  panel.id = "patternPanel";
  panel.className = "panel hidden";
  panel.setAttribute("aria-label", "阵列与镜像参数");
  panel.innerHTML = `<div class="pt-head"><b id="ptTitle"></b><button type="button" id="ptClose" aria-label="取消阵列或镜像">✕</button></div><form id="ptForm"><div id="ptFields"></div><p id="ptHint"></p><p id="ptStatus" role="status" aria-live="polite"></p><div class="pt-actions"><button type="button" id="ptPreview">预览</button><button type="submit" id="ptApply" class="primary">应用</button><button type="button" id="ptCancel">取消</button></div></form>`;
  document.body.appendChild(panel);
  const $ = (id) => panel.querySelector(`#${id}`);
  let original = null;
  let availableSources = new Set();
  let previousFocus = null;
  function invalid(input, message) {
    input?.setCustomValidity(message);
    input?.focus();
    input?.reportValidity();
    throw new Error(message);
  }
  const api = {
    get visible() { return !panel.classList.contains("hidden"); },
    open({ op, sources, editing = false }) {
      original = op;
      previousFocus = document.activeElement;
      availableSources = new Set(sources.map((source) => source.index));
      const mirror = op.type === "mirror";
      $("ptTitle").textContent = `${editing ? "编辑" : "创建"}${mirror ? "镜像" : op.kind === "circular" ? "圆周阵列" : "线性阵列"}`;
      const sourceEntries = sources.map((s) => [s.index, s.name]);
      const hasSource = availableSources.has(op.source);
      if (!hasSource) sourceEntries.unshift(["", "请选择有效源特征"]);
      const source = row("ptSource", "源特征", sourceEntries, hasSource ? op.source : "");
      let fields = "";
      if (mirror) {
        fields = row("ptPlane", "镜像平面", [["YZ", "YZ（垂直 X）"], ["XZ", "XZ（垂直 Y）"], ["XY", "XY（垂直 Z）"]], op.plane)
          + row("ptAt", "平面位置", [["world", "世界原点"], ["offset", "固定偏移"], ["bboxMin", "模型最小边（关联）"], ["bboxMax", "模型最大边（关联）"]], op.at)
          + `<div id="ptOffsetRow">${number("ptOffset", "偏移（mm，可为负）", op.offset ?? 0)}</div>`;
      } else {
        fields = number("ptCount", "数量（包含原特征）", op.count, 'min="2" max="64"', true);
        const vector = op.kind === "linear" ? op.direction : op.axisDir;
        const axes = Object.keys(AXES).map((key) => [key, key]);
        if (vecKey(vector) === "custom") axes.push(["custom", `原方向 (${vector.join(", ")})`]);
        fields += row("ptDirection", op.kind === "linear" ? "排列方向" : "旋转轴方向", axes, vecKey(vector));
        if (op.kind === "linear") fields += number("ptSpacing", "相邻间距（mm，大于 0）", op.spacing, 'min="0"');
        else {
          fields += number("ptAngle", "分布总角度（°，大于 0）", op.angle, 'min="0" max="360"');
          fields += '<fieldset class="pt-origin"><legend>旋转轴经过的点（mm）</legend>'
            + op.axisPoint.map((v, i) => number(`ptOrigin${i}`, ["X", "Y", "Z"][i], v)).join("") + '</fieldset>';
        }
      }
      $("ptFields").innerHTML = source + fields;
      $("ptHint").textContent = mirror ? "随源特征加料或挖料。关联平面会随上游尺寸变化，固定偏移保持不动。"
        : op.kind === "linear" ? "间距固定保存。改变零件宽度不会自动改变排列间距。"
          : "360°整圈均布，不重复末端；小于360°时包含起点和终点。";
      $("ptApply").textContent = editing ? "更新特征" : "应用";
      api.status("先预览查看结果，应用后写入特征树。");
      panel.classList.remove("hidden");
      panel.scrollTop = 0;
      updateConditionalFields();
      $("ptSource").focus();
    },
    read() {
      if (!original) throw new Error("请先打开阵列或镜像参数面板");
      const n = (id, { positive = false, integer = false, min = -Infinity, max = Infinity } = {}) => {
        const input = $(id);
        const label = input.dataset.label || "源特征";
        input.setCustomValidity("");
        if (input.value.trim() === "" || input.validity?.badInput) return invalid(input, `请填写${label}`);
        const value = Number(input.value);
        if (!Number.isFinite(value)) return invalid(input, `${label}必须是有限数值`);
        if (integer && !Number.isSafeInteger(value)) return invalid(input, `${label}必须是整数`);
        if (value < min) return invalid(input, `${label}不能小于 ${min}`);
        if (value > max) return invalid(input, `${label}不能超过 ${max}`);
        if (positive && value <= 0) return invalid(input, `${label}必须大于 0`);
        return value;
      };
      const op = { ...original, source: n("ptSource") };
      if (!availableSources.has(op.source)) return invalid($("ptSource"), "请选择有效的源特征");
      if (op.type === "mirror") {
        op.plane = $("ptPlane").value;
        op.at = $("ptAt").value;
        if (!["XY", "XZ", "YZ"].includes(op.plane)) return invalid($("ptPlane"), "请选择镜像平面");
        if (!["world", "offset", "bboxMin", "bboxMax"].includes(op.at)) return invalid($("ptAt"), "请选择镜像平面位置");
        // 隐藏的偏移不参与读取和校验；关联位置由建模层重新计算。
        op.offset = op.at === "offset" ? n("ptOffset") : 0;
        delete op.off;
      } else {
        op.count = n("ptCount", { integer: true, min: 2, max: 64 });
        const key = $("ptDirection").value;
        if (!Object.hasOwn(AXES, key) && key !== "custom") return invalid($("ptDirection"), "请选择排列或旋转轴方向");
        const vector = AXES[key] || (op.kind === "linear" ? original.direction : original.axisDir);
        if (op.kind === "linear") { op.direction = [...vector]; op.spacing = n("ptSpacing", { positive: true }); }
        else { op.axisDir = [...vector]; op.angle = n("ptAngle", { positive: true, max: 360 }); op.axisPoint = [0, 1, 2].map((i) => n(`ptOrigin${i}`)); }
      }
      return op;
    },
    status(message, error = false) { $("ptStatus").textContent = message; $("ptStatus").classList.toggle("error", error); },
    close() {
      panel.classList.add("hidden");
      original = null;
      if (previousFocus?.isConnected) previousFocus.focus();
      previousFocus = null;
    },
  };
  function updateConditionalFields() {
    if (!$("ptOffsetRow")) return;
    const hidden = $("ptAt").value !== "offset";
    $("ptOffsetRow").hidden = hidden;
    $("ptOffset").disabled = hidden;
    $("ptOffset").required = !hidden;
    if (hidden) $("ptOffset").setCustomValidity("");
  }
  function run(callback) {
    try { api.read(); }
    catch (error) { api.status(error.message, true); return; }
    callback();
  }
  $("ptForm").addEventListener("submit", (event) => { event.preventDefault(); run(onApply); });
  $("ptPreview").onclick = () => run(onPreview);
  $("ptCancel").onclick = $("ptClose").onclick = () => onCancel();
  function changed(event) {
    event.target.setCustomValidity?.("");
    updateConditionalFields();
    onChange();
  }
  $("ptFields").addEventListener("input", changed);
  $("ptFields").addEventListener("change", changed);
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
  });
  return api;
}
