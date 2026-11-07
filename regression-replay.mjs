import assert from "node:assert/strict";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import * as OPS from "./src/ops.js";
import { rebuild, makeEdgeRefs, RefLost } from "./src/replay.js";

setOC(await opencascade({ wasmBinary: fs.readFileSync("./public/replicad_single.wasm") }));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
const close = (a, b, tolerance = 1e-3) => assert.ok(Math.abs(a-b) < tolerance, `${a} != ${b}`);
const plane = { kind:"datum", name:"XY", origin:[0,0,0], normal:[0,0,1], xDir:[1,0,0] };
const base = { label:"base", op:{ type:"base" } };
const extrude = { type:"extrude", plane, entities:[{kind:"rect", c:[0,0], w:10, h:6}], depth:5, grow:0 };
test("standalone datum extrusion survives JSON reload", () => {
  const history = JSON.parse(JSON.stringify([{op:extrude}]));
  const result = rebuild(history,0);
  close(measureVolume(result.shape),300);
  assert.equal(result.tools.length,1);
  close(measureVolume(result.tools[0]),300);
});
test("cut cannot create an empty document", () => {
  assert.throws(() => rebuild([{op:{...extrude,depth:-5}}],0), /已有的实体/);
});
test("suppression creates current snapshots and null feature tools", () => {
  const history = [{op:extrude}, {op:{type:"move3d",dx:25},suppressed:true}, {op:{type:"move3d",dy:10}}];
  const result = rebuild(history,2);
  assert.deepEqual(result.snapshots.map(s=>s.index),[0,1,2]);
  assert.equal(result.tools[1],null);
  close(result.snapshots[1].shape.boundingBox.center[0],0);
  close(result.snapshots[2].shape.boundingBox.center[1],10);
  close(result.snapshots[0].shape.boundingBox.center[1],0);
});
test("partial or duplicate edge references fail rather than silently modify fewer edges", () => {
  const shape = OPS.starterModel();
  const mid = shape.edges.map(OPS.edgeMidPoint).find(m=>m && Math.abs(Math.abs(m[0])-30)<.01 && Math.abs(Math.abs(m[1])-20)<.01);
  const valid = makeEdgeRefs(shape,[mid])[0];
  const missing = {mid:[999,999,999],norm:[9,9,9],dir:valid.dir};
  for (const refs of [[valid,missing],[valid,valid]]) {
    assert.throws(()=>rebuild([base,{op:{type:"fillet",edgeRefs:refs,radius:1}}],1),
      e=>e instanceof RefLost && e.stepIndex===1 && /全部/.test(e.message));
  }
});
test("sweep replays stored normal path and dimensional constraints", () => {
  const op = {type:"sweep",plane,entities:[{kind:"circle",c:[0,0],r:2},{kind:"rect",c:[15,0],w:10,h:2}],
    constraints:[{type:"fixed",e:0,k:"r",value:3,label:"R3"}],length:12};
  const json = JSON.stringify(op);
  const result = rebuild([{op:JSON.parse(json)}],0);
  close(measureVolume(result.shape),Math.PI*9*12,.01);
  close(result.shape.boundingBox.depth,12);
  assert.equal(JSON.stringify(op),json);
});
test("sweep length edits regenerate the feature", () => {
  const op = {type:"sweep",plane,entities:[{kind:"circle",c:[0,0],r:2},{kind:"rect",c:[15,0],w:10,h:2}],length:12};
  const result = rebuild([{op}],0,{0:{...op,length:20}});
  close(measureVolume(result.shape),Math.PI*4*20,.01);
});
test("cut mirror removes a matching hole instead of adding material", () => {
  const hole = {type:"extrude",plane:{...plane,origin:[0,0,8]},entities:[{kind:"circle",c:[15,0],r:2}],depth:-8,grow:0};
  const hist = [base,{op:hole},{op:{type:"mirror",source:1,plane:"YZ",at:"world",off:[0,0,0],operation:"cut"}}];
  const result = rebuild(JSON.parse(JSON.stringify(hist)),2);
  close(measureVolume(result.shape),measureVolume(OPS.starterModel()) - 2*Math.PI*4*8,.01);
});
test("cut pattern removes repeated holes", () => {
  const hole = {type:"extrude",plane:{...plane,origin:[0,0,8]},entities:[{kind:"circle",c:[15,0],r:2}],depth:-8,grow:0};
  const hist = [base,{op:hole},{op:{type:"pattern",source:1,kind:"circular",count:4,operation:"cut"}}];
  const result = rebuild(hist,2);
  close(measureVolume(result.shape),measureVolume(OPS.starterModel()) - 4*Math.PI*4*8,.01);
});
test("bbox mirror recomputes its position after upstream size edits", () => {
  const history = [{op:extrude},{op:{type:"mirror",source:0,plane:"YZ",at:"bboxMax",off:[10,0,0]}}];
  const result = rebuild(history,1,{0:{...extrude,entities:[{kind:"rect",c:[0,0],w:20,h:6}]}});
  close(result.shape.boundingBox.width,40);
  close(measureVolume(result.shape),1200);
});
test("rebuild rejects nonexistent target steps", () => {
  for (const target of [-1,1,1.5,NaN]) assert.throws(()=>rebuild([base],target), /历史范围/);
});
console.log(`Replay regressions: ${passed} passed`);
