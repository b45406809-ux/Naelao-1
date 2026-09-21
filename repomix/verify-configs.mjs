import { readdir, readFile } from "node:fs/promises";
const manifest=JSON.parse(await readFile("repomix/phases.json","utf8"));
if(manifest.schema_version!==3||manifest.target_input_tokens>32000||manifest.hard_input_tokens>96000) throw new Error("Vertical-slice token guards are missing or too large");
if(manifest.phases.length<20||manifest.phases.length>40) throw new Error(`Expected 20-40 cohesive vertical slices, found ${manifest.phases.length}`);
let expected=1;
for(const [index,phase] of manifest.phases.entries()){
 if(phase.phase!==index+1||phase.slice_id!==`slice-${String(index+1).padStart(2,"0")}`) throw new Error(`Invalid slice identity at ${index+1}`);
 if(phase.from!==expected||phase.to<phase.from||phase.to>130)throw new Error(`Non-contiguous slice ${phase.phase}`);expected=phase.to+1;
 if(index===0 ? phase.depends_on.length!==0 : phase.depends_on.length!==1||phase.depends_on[0]!==index) throw new Error(`Invalid dependency for ${phase.slice_id}`);
 const prompt=await readFile(phase.prompt,"utf8");
 for(let item=phase.from;item<=phase.to;item++){const start=prompt.indexOf(`### ${item}. `);if(start<0)throw new Error(`${phase.prompt} omits item ${item}`);const end=prompt.indexOf("\n### ",start+5),part=prompt.slice(start,end<0?undefined:end);for(const mark of ["**Final behavior:**","**Production acceptance contract:**","**Retained implementation constraints:**"])if(!part.includes(mark))throw new Error(`${phase.prompt} item ${item} omits ${mark}`);}
 for(const mark of ["This prompt is self-contained","PHASE_STATUS: CONTINUE","PHASE_STATUS: COMPLETE"])if(!prompt.includes(mark))throw new Error(`${phase.prompt} omits ${mark}`);
}
if(expected!==131)throw new Error("Vertical slices do not cover items 1-130 exactly once");
const configs=(await readdir("repomix")).filter(x=>/^batch-\d{2}-.+\.json$/.test(x)).sort();if(configs.length!==13)throw new Error("Expected 13 domain source profiles");
for(const file of configs){const c=JSON.parse(await readFile(`repomix/${file}`,"utf8"));if(c.output.compress===true||c.output.removeComments!==false||c.output.removeEmptyLines!==false||c.output.showLineNumbers!==true)throw new Error(`${file} must retain line-numbered full source`);}
console.log(`Verified ${manifest.phases.length} dependency-ordered vertical slices covering items 1-130.`);
