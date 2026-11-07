import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { rebuild, RefLost } from "./src/replay.js";
import { solveSketch } from "./src/solver.js";
import { cacheRebuild, withoutFeature } from "./src/project.js";

const source = fs.readFileSync("./src/main.js", "utf8");
const noop = () => {};
function appFunction(name) {
  const match = source.match(new RegExp(`^function ${name}\\([^]*?^\\}`, "m"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}
function context(state = {}, functions = []) {
  const elements = new Map();
  const c = vm.createContext({
    history: [], hIndex: 0, shape: null, mode: "select", editingStep: null,
    featPreviewShape: null, featPreviewing: false, faceClass: null, curvedDriver: null,
    selectedFaceId: null, selSnap: null, dim: {hide:noop}, performance,
    viewer: {clearHighlight:noop,clearSketchLines:noop,setEdgeData:noop},
    renderTree:noop,renderFeatTree:noop,refresh:noop,closePatternEditor:noop,
    featureDisplayName:h=>h.label, EDITABLE:{extrude:{key:"depth",label:"深度",unit:"mm",step:1}}, FEAT_GROUP:{},
    cacheRebuild, withoutFeature, rebuild, solveSketch, RefLost,
    ...state,
  });
  c.$ = id => {
    if (!elements.has(id)) elements.set(id,{value:"",textContent:"",classList:{add:noop,remove:noop}});
    return elements.get(id);
  };
  c.setStats = msg => { c.lastMessage = msg; };
  c.selectFace = () => {c.selectedFaceId=null;c.curvedDriver=null;c.faceClass=null;};
  c.exitLinkMode = () => {c.mode="select";c.linkSource=null;};
  c.exitEdgeMode = () => {c.mode="select";};
  c.exitSketch = () => {c.mode="select";c.sketch=null;};
  c.cancelSmartDim = () => {c.mode="select";c.spPreviewing=false;};
  for (const name of ["closeEdit","cancelEdit",...functions]) vm.runInContext(appFunction(name),c);
  return c;
}
const fakeShape = () => ({faces:[]});
const planar = {type:"extrude",depth:5,plane:{kind:"datum",name:"XY",origin:[0,0,0],normal:[0,0,1],xDir:[1,0,0]},
  entities:[{kind:"circle",c:[0,0],r:2}],constraints:[],selected:[],grow:0};
const row = () => ({label:"拉伸",op:structuredClone(planar),shape:fakeShape()});

test("editing a future feature first restores its history position", () => {
  const c = context({history:[row(),row(),row()],hIndex:0},["gotoStep","editStep"]);
  vm.runInContext("editStep(2)",c);
  assert.equal(c.hIndex,2);
  assert.equal(c.editingStep,2);
  assert.equal(c.history.length,3);
  assert.equal(c.shape,c.history[2].shape);
});
test("future sketch editing restores the target and selected contours", () => {
  const rows=[row(),row()]; rows[1].op.selected=[0];
  const c=context({history:rows,hIndex:0,resolvePlane:()=>({}),SketchSession:class{}},["gotoStep","editSketchOf"]);
  c.beginSketch=s=>{c.sketch=s;c.mode="sketch";};
  vm.runInContext("editSketchOf(1)",c);
  assert.equal(c.hIndex,1);
  assert.deepEqual(Array.from(c.sketch.selected),[0]);
  assert.notEqual(c.sketch.selected,rows[1].op.selected);
});
test("sketch edit commits contour selection and rolls back definitions on failure", () => {
  const h=row();
  const c=context({history:[h],sketch:{entities:h.op.entities,constraints:[],selected:[0]},
    detailOf:()=>"edited",redrawSketch:noop,rebuildAndApply:()=>false},["commitSketchEdit"]);
  const original=h.op;
  vm.runInContext("commitSketchEdit(0)",c);
  assert.equal(h.op,original);
  c.rebuildAndApply=()=>true;
  vm.runInContext("commitSketchEdit(0)",c);
  assert.deepEqual(Array.from(h.op.selected),[0]);
});
test("planar controllers skip future and suppressed features; curves require a selected real face", () => {
  const h=[row(),{...row(),suppressed:true},row()];
  const c=context({history:h,hIndex:1},["findController","findCurvedDriver"]);
  const planarHits=vm.runInContext("findController({center:[0,0,5],normal:[0,0,1]})",c);
  assert.deepEqual(Array.from(planarHits,x=>x.i),[0]);
  const curvedHits=vm.runInContext("findCurvedDriver({radius:2,kind:'cylinder'})",c);
  assert.deepEqual(Array.from(curvedHits,x=>x.i),[]);
  c.history[0].op.selected=[1];
  assert.equal(vm.runInContext("findCurvedDriver({radius:2,kind:'cylinder'}).length",c),0);
});
test("history navigation clears link and curved-surface state", () => {
  const c=context({history:[row(),row()],hIndex:1,mode:"link",linkSource:{stale:true},curvedDriver:{i:1}},["gotoStep"]);
  vm.runInContext("gotoStep(0)",c);
  assert.equal(c.mode,"select");
  assert.equal(c.linkSource,null);
  assert.equal(c.curvedDriver,null);
});
for (const name of ["deleteStep","toggleSuppress"]) test(`${name} cancels parameter preview before rollback`, () => {
  const original=fakeShape(),preview=fakeShape();
  const rows=[row(),row(),row()];
  const c=context({history:rows,hIndex:2,shape:preview,featPreviewShape:original,featPreviewing:true,
    rebuild(){throw new Error("expected downstream failure");}},[name]);
  vm.runInContext(`${name}(1)`,c);
  assert.equal(c.shape,original);
  assert.equal(c.featPreviewing,false);
  assert.equal(c.featPreviewShape,null);
  assert.equal(c.history,rows);
  assert.equal(c.history.length,3);
});
test("deletion and suppression do not discard an active unfinished sketch", () => {
  for (const name of ["deleteStep","toggleSuppress"]) {
    const rows=[row(),row()];
    const c=context({history:rows,hIndex:1,mode:"sketch"},[name]);
    vm.runInContext(`${name}(1)`,c);
    assert.equal(c.history,rows);
    assert.equal(c.history[1].suppressed,undefined);
    assert.match(c.lastMessage,/完成或取消草图/);
  }
});

setOC(await opencascade({wasmBinary:fs.readFileSync("./public/replicad_single.wasm")}));
function circleContext(conflict=false) {
  const h=row();
  h.op.constraints=[{type:"fixed",e:0,k:"r",value:2}];
  if(conflict) {
    h.op.entities.push({kind:"circle",c:[10,0],r:2});
    h.op.constraints.push({type:"fixed",e:1,k:"r",value:2},{type:"equal",e:0,f:1,k:"r"});
  }
  const result=rebuild([h],0);
  const c=context({history:[h],hIndex:0,shape:result.shape,faceClass:{kind:"cylinder"},
    curvedDriver:{kind:"sketchCircle",i:0,sub:0},curvedDimSpec:()=>({kind:"圆柱直径"}),detailOf:()=>"edited"},
    ["acceptRebuild","curvedDimOperation","commitCurvedDim"]);
  return c;
}
test("cylinder diameter edit updates driving radius constraint and measured volume", () => {
  const c=circleContext();
  vm.runInContext("commitCurvedDim(8)",c);
  assert.equal(c.history[0].op.entities[0].r,4);
  assert.equal(c.history[0].op.constraints[0].value,4);
  assert.ok(Math.abs(measureVolume(c.shape)-Math.PI*16*5)<1e-3);
});
test("conflicting cylinder diameter edit leaves geometry and definitions intact", () => {
  const c=circleContext(true);
  const shape=c.shape,op=c.history[0].op;
  vm.runInContext("commitCurvedDim(8)",c);
  assert.equal(c.shape,shape);
  assert.equal(c.history[0].op,op);
  assert.equal(c.history[0].op.constraints[0].value,2);
  assert.match(c.lastMessage,/冲突/);
});
