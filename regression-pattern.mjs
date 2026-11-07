import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import opencascade from "replicad-opencascadejs";
import { setOC, makeBaseBox, makeCylinder, measureVolume } from "replicad";
import { normalizePatternOp, applyPatternOp } from "./src/pattern.js";
import { rebuild, RefLost } from "./src/replay.js";
import { starterModel } from "./src/ops.js";

setOC(await opencascade({wasmBinary:fs.readFileSync("./public/replicad_single.wasm")}));
const near=(a,b,tol=1e-4)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
const linear=(extra={})=>({type:"pattern",kind:"linear",source:0,count:3,operation:"fuse",direction:[1,0,0],spacing:7,...extra});
const circular=(extra={})=>({type:"pattern",kind:"circular",source:0,count:4,operation:"fuse",axisPoint:[0,0,0],axisDir:[0,0,1],angle:360,...extra});
const mirror=(extra={})=>({type:"mirror",source:0,plane:"YZ",at:"world",operation:"fuse",...extra});
const box=()=>makeBaseBox(2,2,2);
const limits=(shape,axis=0)=>{
  const bb=shape.boundingBox;
  const width=[bb.width,bb.height,bb.depth][axis];
  return [bb.center[axis]-width/2,bb.center[axis]+width/2];
};

test("linear copies use explicit spacing and leave base/source usable",()=>{
  const source=box(),base=source.clone();
  const r=applyPatternOp(base,source,linear());
  near(measureVolume(r.shape),24);
  near(measureVolume(r.tool),16);
  near(r.shape.boundingBox.width,16);
  near(measureVolume(base),8);
  near(measureVolume(source),8);
});
test("explicit spacing remains fixed when upstream model width changes",()=>{
  const source=box();
  const saved=normalizePatternOp(linear(),source);
  const changedBase=makeBaseBox(60,10,2);
  const r=applyPatternOp(changedBase,source,saved);
  near(r.tool.boundingBox.width,9);
  near(r.tool.boundingBox.center[0],10.5);
  assert.equal(r.op.spacing,7);
});
test("newly materialized legacy defaults stay fixed after JSON serialization",()=>{
  const source=box();
  const legacy={type:"pattern",source:0,count:3};
  const saved=normalizePatternOp(legacy,source);
  assert.equal(saved.spacing,1);
  assert.deepEqual(saved.direction,[1,0,0]);
  const changedBase=makeBaseBox(20,10,2);
  assert.equal(normalizePatternOp(JSON.parse(JSON.stringify(saved)),changedBase).spacing,1);
  assert.equal(normalizePatternOp(legacy,changedBase).spacing,10);
  assert.equal(legacy.spacing,undefined);
});
test("linear negative and arbitrary directions keep millimeter spacing",()=>{
  const source=box();
  const reverse=applyPatternOp(source,source,linear({direction:[-2,0,0]}));
  near(limits(reverse.shape)[0],-15);
  near(limits(reverse.shape)[1],1);
  const diagonal=applyPatternOp(source,source,linear({count:2,direction:[3,4,0],spacing:10}));
  near(diagonal.tool.boundingBox.center[0],6);
  near(diagonal.tool.boundingBox.center[1],8);
  assert.deepEqual(normalizePatternOp(linear({direction:[Number.MIN_VALUE,0,0]}),source).direction,[1,0,0]);
  const extreme=normalizePatternOp(linear({direction:[Number.MAX_VALUE,Number.MAX_VALUE,0]}),source).direction;
  near(Math.hypot(...extreme),1);
});
test("360 degree circular pattern has count instances with no repeated endpoint",()=>{
  const source=makeCylinder(1,2,[10,0,0],[0,0,1]);
  const r=applyPatternOp(source,source,circular());
  near(measureVolume(r.shape),8*Math.PI);
  near(measureVolume(r.tool),6*Math.PI);
  near(r.shape.boundingBox.width,22);
  near(r.shape.boundingBox.height,22);
});
test("partial circular pattern includes both ends of its angular span",()=>{
  const source=makeCylinder(1,2,[10,0,0],[0,0,1]);
  const r=applyPatternOp(source,source,circular({angle:180,count:3}));
  near(measureVolume(r.shape),6*Math.PI);
  near(limits(r.shape,0)[0],-11);
  near(limits(r.shape,0)[1],11);
  near(limits(r.shape,1)[1],11);
  near(limits(r.shape,1)[0],-1);
});
test("partial two-instance circular pattern and reversed axis reach correct endpoints",()=>{
  const source=box().translate([10,0,0]);
  const r=applyPatternOp(source,source,circular({count:2,angle:90,axisDir:[0,0,-4]}));
  near(r.tool.boundingBox.center[0],0);
  near(r.tool.boundingBox.center[1],-10);
});
test("circular axis point is explicit and independent of upstream bounding box",()=>{
  const source=box().translate([20,0,0]);
  const r=applyPatternOp(makeBaseBox(100,20,2),source,circular({count:2,angle:180,axisPoint:[15,0,0]}));
  near(r.tool.boundingBox.center[0],10);
  near(r.tool.boundingBox.center[1],0);
});
test("mirror uses signed plane offset, including negative positions",()=>{
  const source=box().translate([8,0,0]);
  for(const offset of [5,-3]){
    const r=applyPatternOp(source,source,mirror({at:"offset",offset}));
    near(r.tool.boundingBox.center[0],2*offset-8);
    near(measureVolume(r.shape),16);
    near(measureVolume(source),8);
  }
});
test("mirror world and all three plane orientations are supported",()=>{
  const source=box().translate([8,9,10]);
  for(const [plane,axis] of [["YZ",0],["XZ",1],["XY",2]]){
    const original=source.boundingBox.center;
    const r=applyPatternOp(source,source,mirror({plane}));
    for(let k=0;k<3;k++) near(r.tool.boundingBox.center[k],k===axis?-original[k]:original[k]);
  }
});
test("bbox mirror modes remain associated after upstream size changes",()=>{
  const source=box();
  for(const at of ["bboxMin","bboxMax"]){
    const saved=normalizePatternOp(mirror({at}),source);
    const r=applyPatternOp(makeBaseBox(20,10,2),source,JSON.parse(JSON.stringify(saved)));
    near(r.tool.boundingBox.center[0],at==="bboxMin"?-20:20);
    near(r.op.offset,at==="bboxMin"?-10:10);
  }
});
test("legacy mirror translation migrates to its equivalent signed offset",()=>{
  const source=box().translate([8,0,0]);
  const old={type:"mirror",source:0,plane:"YZ",off:[10,0,0]};
  const r=applyPatternOp(source,source,old);
  assert.equal(r.op.at,"offset");
  assert.equal(r.op.offset,5);
  assert.equal(r.op.off,undefined);
  near(r.tool.boundingBox.center[0],2);
});
test("cut patterns and cut mirrors retain source holes and remove copies",()=>{
  const plate=makeBaseBox(40,30,5);
  const hole=makeCylinder(1,5,[8,0,0],[0,0,1]);
  const base=plate.cut(hole);
  const r=applyPatternOp(base,hole,circular({operation:"cut"}));
  near(measureVolume(r.shape),40*30*5-4*5*Math.PI);
  const m=applyPatternOp(base,hole,mirror({operation:"cut"}));
  near(measureVolume(m.shape),40*30*5-2*5*Math.PI);
});
const plane={kind:"datum",name:"XY",origin:[0,0,8],normal:[0,0,1],xDir:[1,0,0]};
test("explicit parameters survive JSON save and complete history replay",()=>{
  const cut={type:"extrude",plane,entities:[{kind:"circle",c:[12,0],r:2}],depth:-8,grow:0};
  const h=[{op:{type:"base"}},{op:cut},{op:circular({source:1,count:3,angle:180,operation:"cut"})}];
  const r=rebuild(JSON.parse(JSON.stringify(h)),2);
  near(measureVolume(r.shape),measureVolume(starterModel())-3*32*Math.PI);
  assert.ok(r.tools[2]);
});
test("invalid counts, spacing, vectors, angles, planes, and operations fail without clamping",()=>{
  const source=box();
  for(const count of [1,65,2.5,NaN,Infinity,"3",undefined]) assert.throws(()=>normalizePatternOp(linear({count}),source));
  for(const spacing of [0,-1,NaN,Infinity,"5"]) assert.throws(()=>normalizePatternOp(linear({spacing}),source));
  for(const direction of [[0,0,0],[1,2],[Infinity,0,0],null]) assert.throws(()=>normalizePatternOp(linear({direction}),source));
  for(const angle of [0,-90,361,NaN,Infinity]) assert.throws(()=>normalizePatternOp(circular({angle}),source));
  for(const axisDir of [[0,0,0],[0,0,NaN]]) assert.throws(()=>normalizePatternOp(circular({axisDir}),source));
  for(const op of [mirror({plane:"bad"}),mirror({at:"bad"}),mirror({at:"offset",offset:Infinity}),linear({source:-1}),linear({operation:"bad"}),linear({kind:"bad"})]){
    assert.throws(()=>normalizePatternOp(op,source));
  }
  near(measureVolume(source),8);
});
test("missing, deleted, suppressed, and future source tools fail explicitly",()=>{
  const source=box();
  assert.throws(()=>applyPatternOp(source,null,linear()),/源特征/);
  const deleted=box();deleted.delete();
  assert.throws(()=>applyPatternOp(source,deleted,linear()),/源特征/);
  const base={op:{type:"base"}};
  const sourceFeature={op:{type:"extrude",plane,entities:[{kind:"circle",c:[12,0],r:2}],depth:5,grow:0},suppressed:true};
  for(const sourceIndex of [1,3]){
    assert.throws(()=>rebuild([base,sourceFeature,{op:linear({source:sourceIndex})}],2),e=>e instanceof RefLost&&e.stepIndex===2);
  }
});
