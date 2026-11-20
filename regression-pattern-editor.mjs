import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import opencascade from "replicad-opencascadejs";
import { setOC, measureVolume } from "replicad";
import { normalizePatternOp, applyPatternOp } from "./src/pattern.js";
import { rebuild } from "./src/replay.js";
import { cacheRebuild } from "./src/project.js";
import { markSnapshot } from "./src/history-cache.js";
import { replaceStep, appendStep, rebuildInto } from "./src/param-edit.js";
import { sandboxCommands } from "./sandbox-command-stub.mjs";

setOC(await opencascade({wasmBinary:fs.readFileSync("./public/replicad_single.wasm")}));
const source=fs.readFileSync("./src/main.js","utf8");
function appFunction(name){
  const match=source.match(new RegExp(`^function ${name}\\([^]*?^\\}`,"m"));
  assert.ok(match,`missing application function ${name}`);
  return match[0];
}
const noop=()=>{};
const near=(a,b)=>assert.ok(Math.abs(a-b)<1e-4,`${a} != ${b}`);
const plane={kind:"datum",name:"XY",origin:[0,0,0],normal:[0,0,1],xDir:[1,0,0]};
const feature=()=>({label:"原始凸台",op:{type:"extrude",plane,entities:[{kind:"rect",c:[0,0],w:2,h:2}],depth:2,grow:0}});
const pattern=(sourceIndex=0)=>({type:"pattern",kind:"linear",source:sourceIndex,count:3,spacing:6,direction:[1,0,0],operation:"fuse"});
const definitions=h=>JSON.stringify(h.map(({op,label,detail,suppressed})=>({op,label,detail,suppressed})));

function editor(rows=[feature()],cursor=rows.length-1){
  const history=structuredClone(rows);
  cacheRebuild(history,rebuild(history,history.length-1));
  const c=vm.createContext({history,hIndex:cursor,shape:history[cursor].shape,mode:"select",appMode:"model",
    patternSession:null,normalizePatternOp,applyPatternOp,rebuild,cacheRebuild,markSnapshot,performance,
    FEATURE_ICON:{},selectFace:noop,refresh:noop,renderTree:noop,
    featureDisplayName:h=>h.label,replaceStep,appendStep,rebuildInto,
  });
  c.docCommands=sandboxCommands(c);
  c.patternPanel={
    visible:false,draft:null,lastStatus:"",isError:false,
    open({op,sources,editing}){this.visible=true;this.draft=structuredClone(op);this.sources=sources;this.editing=editing;},
    read(){return structuredClone(this.draft);},
    status(text,error=false){this.lastStatus=text;this.isError=error;},
    close(){this.visible=false;},
  };
  c.setStats=text=>{c.lastMessage=text;};
  c.setMode=mode=>{c.mode=mode;};
  c.exitEdgeMode=c.exitLinkMode=c.cancelSmartDim=()=>{c.mode="select";};
  c.cancelEdit=()=>vm.runInContext("closePatternEditor()",c);
  c.gotoStep=index=>{
    if(index<0||index>=c.history.length)return;
    vm.runInContext("closePatternEditor()",c);
    c.hIndex=index;c.shape=c.history[index].shape;
  };
  for(const name of ["detailOf","commit","acceptRebuild","closePatternEditor","openPatternEditor","evaluatePatternEditor"]){
    vm.runInContext(appFunction(name),c);
  }
  return c;
}
const open=(c,kind="linear",index=null)=>vm.runInContext(`openPatternEditor(${JSON.stringify(kind)},${index})`,c);
const evaluate=(c,apply)=>vm.runInContext(`evaluatePatternEditor(${apply})`,c);

test("creation preview changes only displayed geometry; cancel restores exact original",()=>{
  const c=editor(),history=c.history,original=c.shape,before=definitions(history);
  open(c);Object.assign(c.patternPanel.draft,pattern());
  evaluate(c,false);
  near(measureVolume(c.shape),24);
  assert.equal(c.history,history);
  assert.equal(definitions(c.history),before);
  assert.equal(c.hIndex,0);
  assert.equal(c.patternSession.previewing,true);
  vm.runInContext("closePatternEditor()",c);
  assert.equal(c.shape,original);
  assert.equal(c.patternSession,null);
  assert.equal(c.patternPanel.visible,false);
});
test("repeated previews do not compound copies",()=>{
  const c=editor();open(c);
  Object.assign(c.patternPanel.draft,pattern());evaluate(c,false);
  c.patternPanel.draft.count=4;evaluate(c,false);
  near(measureVolume(c.shape),32);
  assert.equal(c.history.length,1);
  vm.runInContext("closePatternEditor()",c);
  near(measureVolume(c.shape),8);
});
test("invalid preview and invalid apply restore geometry and do not mutate definitions",()=>{
  for(const apply of [false,true]){
    const c=editor(),shape=c.shape,before=definitions(c.history);
    open(c);Object.assign(c.patternPanel.draft,pattern());evaluate(c,false);
    c.patternPanel.draft.spacing=0;evaluate(c,apply);
    assert.equal(c.shape,shape);
    assert.equal(definitions(c.history),before);
    assert.equal(c.patternPanel.isError,true);
    assert.match(c.patternPanel.lastStatus,/间距/);
  }
});
test("apply appends exactly one normalized feature and retains usable source tool",()=>{
  const c=editor(),sourceTool=c.history[0].toolShape,before=definitions(c.history);
  open(c);Object.assign(c.patternPanel.draft,pattern());evaluate(c,false);evaluate(c,true);
  assert.equal(c.history.length,2);
  assert.equal(c.hIndex,1);
  assert.equal(definitions(c.history.slice(0,1)),before);
  assert.equal(c.history[0].toolShape,sourceTool);
  near(measureVolume(sourceTool),8);
  near(measureVolume(c.history[1].toolShape),16);
  near(measureVolume(c.shape),24);
  assert.equal(c.history[1].op.spacing,6);
  assert.equal(c.patternSession,null);
});
test("editing existing pattern rebuilds downstream geometry and only changes its definition",()=>{
  const rows=[feature(),{label:"阵列",op:pattern()},{label:"移动",op:{type:"move3d",dx:30}}];
  const c=editor(rows),before=definitions([c.history[0],c.history[2]]),originalShape=c.shape;
  open(c,"linear",1);c.patternPanel.draft.spacing=10;
  evaluate(c,false);
  near(c.shape.boundingBox.width,22);
  near(c.shape.boundingBox.center[0],40);
  assert.equal(c.history[1].op.spacing,6);
  vm.runInContext("closePatternEditor()",c);
  assert.equal(c.shape,originalShape);
  open(c,"linear",1);c.patternPanel.draft.spacing=10;evaluate(c,true);
  assert.equal(c.history.length,3);
  assert.equal(c.history[1].op.spacing,10);
  assert.equal(definitions([c.history[0],c.history[2]]),before);
  near(c.history[1].shape.boundingBox.center[0],10);
  near(c.history[2].shape.boundingBox.center[0],40);
});
test("downstream replay failure rolls back an existing feature edit",()=>{
  const c=editor([feature(),{label:"阵列",op:pattern()},{label:"移动",op:{type:"move3d",dx:30}}]);
  const original=c.shape,before=definitions(c.history),oldOp=c.history[1].op;
  open(c,"linear",1);c.patternPanel.draft.spacing=10;
  c.rebuild=()=>{throw new Error("下游参考面丢失");};
  evaluate(c,true);
  assert.equal(c.shape,original);
  assert.equal(definitions(c.history),before);
  assert.equal(c.history[1].op,oldOp);
  assert.match(c.patternPanel.lastStatus,/下游参考面/);
});
test("cut source automatically selects cutting for circular pattern and mirror",()=>{
  const rows=[{label:"板",op:{type:"base"}},{label:"切孔",op:{type:"extrude",plane:{...plane,origin:[0,0,8]},
    entities:[{kind:"circle",c:[12,0],r:2}],depth:-8,grow:0}}];
  for(const kind of ["circular","mirror"]){
    const c=editor(rows),originalVolume=measureVolume(c.shape);open(c,kind);
    if(kind==="circular")Object.assign(c.patternPanel.draft,{count:4,angle:360,axisPoint:[0,0,0],axisDir:[0,0,1]});
    c.patternPanel.draft.operation="fuse";
    evaluate(c,true);
    assert.equal(c.history[2].op.operation,"cut");
    near(measureVolume(c.shape),originalVolume-(kind==="circular"?3:1)*Math.PI*4*8);
  }
});
test("no valid source and suppressed or future source selections are refused",()=>{
  const noSource=editor([{label:"板",op:{type:"base"}}]);open(noSource);
  assert.equal(noSource.patternSession,null);
  assert.match(noSource.lastMessage,/源特征/);
  for(const sourceIndex of [0,1,99]){
    const c=editor([feature(),feature()],0),before=definitions(c.history),shape=c.shape;
    open(c);c.patternPanel.draft.source=sourceIndex;
    if(sourceIndex===0)c.history[0].suppressed=true;
    evaluate(c,true);
    assert.equal(c.shape,shape);
    assert.equal(c.history.length,2);
    assert.match(c.patternPanel.lastStatus,/源特征/);
    if(sourceIndex!==0)assert.equal(definitions(c.history),before);
  }
});
test("expired history or cursor refuses application without restoring the old document",()=>{
  for(const changed of ["history","cursor"]){
    const c=editor([feature(),{label:"移动",op:{type:"move3d",dx:10}}]);open(c);evaluate(c,false);
    const oldSessionShape=c.patternSession.shape;
    const next=editor([feature(),{label:"移动",op:{type:"move3d",dx:100}}]);
    if(changed==="history"){c.history=next.history;c.shape=next.shape;}
    else {c.hIndex=0;c.shape=c.history[0].shape;}
    const current=c.shape;
    evaluate(c,true);
    assert.equal(c.patternSession,null);
    assert.ok(c.shape===current,"expired editor must preserve the current document's shape");
    assert.ok(c.shape!==oldSessionShape,"expired preview must not restore the old document");
    assert.match(c.lastMessage,/历史位置已变化/);
  }
});
test("closing an expired preview directly cannot restore the old document",()=>{
  for(const changed of ["history","cursor"]){
    const c=editor([feature(),{label:"移动",op:{type:"move3d",dx:10}}]);open(c);evaluate(c,false);
    const replacement=editor([feature(),{label:"移动",op:{type:"move3d",dx:100}}]);
    if(changed==="history"){c.history=replacement.history;c.shape=replacement.shape;}
    else {c.hIndex=0;c.shape=c.history[0].shape;}
    const current=c.shape;
    vm.runInContext("closePatternEditor()",c);
    assert.ok(c.shape===current,"close must preserve geometry belonging to the new history position");
    assert.equal(c.patternSession,null);
  }
});
test("invalid edit indices and non-pattern features are refused without throwing",()=>{
  const c=editor([feature(),{label:"阵列",op:pattern()}]),original=c.shape;
  for(const index of [-1,99,1.5,NaN,0]){
    assert.doesNotThrow(()=>open(c,"linear",index));
    assert.equal(c.patternSession,null);
    assert.ok(c.shape===original);
    assert.match(c.lastMessage,/不存在/);
  }
});
test("canvas picking during the editor cannot select or modify preview faces",()=>{
  const c=editor();c.viewer={};
  const onPick=source.match(/^viewer\.onPick = \([^]*?^};/m);
  assert.ok(onPick,"missing application canvas pick handler");
  vm.runInContext(onPick[0],c);
  open(c);evaluate(c,false);
  const preview=c.shape,before=definitions(c.history);
  let selections=0;c.selectFace=()=>{selections++;};
  vm.runInContext("viewer.onPick(123,null,{x:10,y:10})",c);
  assert.equal(selections,0);
  assert.equal(definitions(c.history),before);
  assert.ok(c.shape===preview);
  assert.match(c.lastMessage,/先应用或取消/);
});
test("opening ordinary feature parameters restores and closes pattern preview",()=>{
  const c=editor(),original=c.shape;
  c.EDITABLE={extrude:{key:"depth",label:"深度",unit:"mm",step:1}};
  c.FEAT_GROUP={};c.featPreviewing=false;
  c.$=()=>({classList:{add:noop,remove:noop}});
  vm.runInContext(appFunction("editStep"),c);
  open(c);evaluate(c,false);
  vm.runInContext("editStep(0)",c);
  assert.equal(c.patternSession,null);
  assert.ok(c.shape===original);
  assert.equal(c.editingStep,0);
});
