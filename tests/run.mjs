// Organon engine tests: `node tests/run.mjs` (no dependencies).
//
// Runs the engine against the template formula, set up as a real app would
// be (a temporary copy of template/ with core/ pointing at this repo). Each
// app's own suite tests its formula on the engine version it pins.

import { mkdtempSync, cpSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = mkdtempSync(join(tmpdir(), 'organon-app-'));
cpSync(join(ROOT, 'template'), APP, { recursive: true });
symlinkSync(ROOT, join(APP, 'core'), 'dir');
const imp = p => import(pathToFileURL(join(APP, p)).href);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) pass++; else { fail++; console.log('  FAIL', msg); } };
const section = s => console.log('•', s);

const formula = (await imp('formula/index.js')).default;
const P = await imp('core/engine/params.js');
const { F, brand } = await imp('core/engine/formula.js');
const { sceneUniforms, specOf, specKey } = await imp('core/engine/renderer.js');
const { fractalFrag } = await imp('core/engine/glsl.js');
const { makeDE, marchInfo, viewScore } = await imp('core/engine/de.js');
const S = await imp('core/engine/presets.js');
const { importMandelbulber, parseFract } = await imp('core/engine/mbimport.js');
const { State } = await imp('core/engine/state.js');
const { Sequencer } = await imp('core/engine/sequencer.js');

// ── Contract ────────────────────────────────────────────────────────────────
section('contract');
ok(F === formula, 'installFormula sets F');
ok(brand().discoveryPrefix === 'TEMPLATE1:' && brand().storagePrefix === 'template', 'brand defaults derive from the formula id');
{
  const { installFormula } = await imp('core/engine/formula.js');
  let threw = false;
  try { installFormula({ id: 'x' }); } catch { threw = true; }
  ok(threw && F === formula, 'an incomplete formula is rejected (and does not replace the installed one)');
  threw = false;
  try { P.defineParams({ groups: [], params: [] }); } catch { threw = true; }
  ok(threw, 'defineParams() refuses a second call');
}

// ── Schema ──────────────────────────────────────────────────────────────────
section('schema');
const gids = new Set(P.GROUPS.map(g => g.id));
ok(gids.has('presets') && gids.has('iter'), 'formula provides presets + iter groups');
for (const g of P.SCENE_GROUPS) ok(gids.has(g.id), `scene group ${g.id} installed`);
const ids = new Set();
for (const p of P.PARAMS) {
  ok(!ids.has(p.id), `duplicate id ${p.id}`); ids.add(p.id);
  ok(gids.has(p.group), `${p.id} has unknown group ${p.group}`);
  ok(P.coerce(p, p.def) === p.def, `${p.id} default survives coerce`);
  if (p.gate) {
    const g = P.PARAM_BY_ID.get(p.gate);
    const eqs = Array.isArray(p.gateEq) ? p.gateEq : [p.gateEq];
    ok(g?.type === 'bool' || (g?.type === 'select' && eqs.every(e => Number.isInteger(e) && e >= 0 && e < g.options.length)), `${p.id}: gate must be a bool, or a select with valid gateEq`);
  }
  if (p.type === 'range') ok(p.min < p.max, `${p.id} min < max`);
}
ok(P.PARAM_BY_ID.get('dist').def === 7 && P.SCENE_PARAMS.find(p => p.id === 'dist').def === 5, 'scene.override changes the installed param, not the shared list');
ok(P.marchParams({ stepFactor: { label: 'X' } }).find(p => p.id === 'stepFactor').label === 'X', 'marchParams overrides');

// ── Shader assembly ─────────────────────────────────────────────────────────
section('shader');
const D = P.defaults();
const su = sceneUniforms(D);
const sp = specOf(su);
ok(specKey(sp) === 'mbox|m0', `spec key ${specKey(sp)}`);
ok(specKey(specOf(sceneUniforms({ ...D, matOn: true }))) === 'mbox|m0|mat', 'material build gets its own key');
const src = fractalFrag(sp);
ok(src.includes('float mapLocal(vec3 p, out float trap)') && src.includes('// ── formula ──'), 'formula source spliced in');
ok(src.indexOf('uniform float u_scale;') < src.indexOf('float mapLocal') && src.indexOf('float mapLocal') < src.indexOf('// Object transform'), 'layout: uniforms → mapLocal → shared tail');
const decl = {};
const ALL = { ...D, matOn: true, light2On: true, repMode: 1, deepZoom: true, colorSource: P.EXP_SMOOTH_SOURCE };
for (const m of fractalFrag(specOf(sceneUniforms(ALL))).matchAll(/uniform\s+(\w+)\s+(\w+)\s*;/g)) decl[m[2]] = m[1];
for (const k of Object.keys(sceneUniforms(ALL))) if (!k.startsWith('__')) ok(k in decl, `uniform ${k} is declared in the shader`);
// Exp-smoothing colour source (opt-in via scene.expSmooth).
{
  const cs = P.PARAM_BY_ID.get('colorSource'), es = P.EXP_SMOOTH_SOURCE;
  ok(es === cs.options.length - 1 && cs.options[es] === 'Exp smoothing', `'Exp smoothing' is the last colour source (index ${es})`);
  ok([].concat(P.PARAM_BY_ID.get('colorIters').gateEq).includes(es) && P.PARAM_BY_ID.get('expSmoothScale').gateEq === es, 'Color Iterations and Smoothing Colour × show for it');
  ok(specKey(specOf(sceneUniforms({ ...D, colorSource: es }))) === 'mbox|m0|es' && specKey(specOf(sceneUniforms({ ...D, colorSource: 1 }))) === 'mbox|m0', 'compiled in only while selected (|es)');
  const on = fractalFrag(specOf(sceneUniforms({ ...D, colorSource: es }))), off = fractalFrag(sp);
  ok(on.includes('#define HAS_EXPSM') && !off.includes('#define HAS_EXPSM') && /expSmoothStep\(r2\)/.test(on), 'template formula calls expSmoothStep(); HAS_EXPSM only when selected');
}
const hasGlslang = spawnSync('glslangValidator', ['--version']).status === 0;
let compiled = 0;
for (const mode of [0, 1, 2]) for (const [mat, xl, rep, dz, es] of [[0, 0, 0, 0, 0], [1, 0, 0, 0, 0], [0, 1, 0, 0, 0], [0, 0, 1, 0, 0], [0, 0, 0, 1, 0], [0, 0, 0, 0, 1], [0, 0, 1, 0, 1], [1, 1, 1, 1, 1]]) {
  for (const texLod of [false, true]) {
    const s = fractalFrag({ ...sp, mode, mat: !!mat, xl: !!xl, rep: !!rep, dz: !!dz, es: !!es }, { texLod });
    ok(s.includes(`#define RENDER_MODE ${mode}`), `mode ${mode} defined`);
    if (!hasGlslang) continue;
    const f = join(APP, 'combo.frag');
    writeFileSync(f, '#version 100\n' + s);
    const r = spawnSync('glslangValidator', [f]);
    ok(r.status === 0, `compiles: mode ${mode} mat ${mat} xl ${xl} rep ${rep} dz ${dz} es ${es} lod ${texLod}\n${String(r.stdout).slice(0, 400)}`);
    compiled++;
  }
}
console.log(hasGlslang ? `    ${compiled} programs compiled (glslangValidator, GLSL ES 1.00)` : '    glslangValidator not installed: compile checks skipped');

// ── Distance estimator ──────────────────────────────────────────────────────
section('distance estimator');
const de = makeDE(D);
ok(de([0, 0, 20]).d > 5, 'far away → large distance');
ok(typeof de.local === 'function', 'makeDE exposes the formula map as .local');
const scaled = makeDE({ ...D, objScale: 2 });
ok(Math.abs(scaled([0, 0, 30]).d - 2 * de([0, 0, 15]).d) < 1e-9, 'object scale multiplies the distance back out');
const moved = makeDE({ ...D, objX: 3 });
ok(Math.abs(moved([3, 0.5, 9]).d - de([0, 0.5, 9]).d) < 1e-12, 'object position shifts the field');
const rep = makeDE({ ...D, repMode: 1, repCountX: 1, repCountZ: 0, repSpaceX: 20 });
ok(Math.abs(rep([20, 0, 9]).d - de([0, 0, 9]).d) < 1e-9, 'grid repetition copies the field');
const vs = viewScore(D, 5);
ok(vs.hitFrac > 0.2 && vs.clearance > 0, `default view sees the fractal (hit ${(vs.hitFrac * 100).toFixed(0)}%)`);
const mi = marchInfo(de, [0, 0, 7], [0, 0, -1], D);
ok(mi.t > 0 && mi.t < 7, `ray from +Z hits (t = ${mi.t?.toFixed?.(3)})`);

// ── Presets / discovery / projects ──────────────────────────────────────────
section('presets');
for (const p of P.PARAMS) if (p.mutate) ok(S.isActive(p, D) || !!p.gate, `${p.id} active or gated`);
ok(!S.isActive(P.PARAM_BY_ID.get('juliaCX'), D) && S.isActive(P.PARAM_BY_ID.get('juliaCX'), { ...D, juliaMode: true }), 'isActive follows the gate');
const v1 = { ...D, ...formula.presets.julia.v, dist: 3.25 };
const str = S.encodeDiscovery(v1);
ok(str.startsWith('TEMPLATE1:'), 'discovery prefix');
const back = S.decodeDiscovery(str);
ok(Object.keys(D).every(k => (typeof v1[k] === 'number' ? Math.abs(back[k] - v1[k]) < 1e-6 * Math.max(1, Math.abs(v1[k])) : back[k] === v1[k])), 'discovery round trip');
const proj = S.parseProject(JSON.stringify(S.makeProject(v1, [v1])));
ok(proj.params.juliaMode === true && proj.keyframes.length === 1 && S.makeProject(v1, []).app === 'template', 'project round trip');
for (let i = 0; i < 20; i++) { const e = S.evolve(D); ok(Object.keys(e).length >= 1 && Object.keys(e).every(k => P.PARAM_BY_ID.get(k)?.mutate), 'evolve changes mutable params'); }
const rb = S.rebirth(D, 8);
ok(rb && rb.values && rb.tries >= 1 && rb.score, 'rebirth returns a scored candidate');

// ── State / sequencer (they read PARAMS lazily) ─────────────────────────────
section('state / sequencer');
const st = new State();
ok(st.get('scale') === -1.8 && st.get('dist') === 7, 'state starts at the formula defaults');
st.set('iterations', 9999);
ok(st.get('iterations') === 250, 'state clamps to hardMax');
const seq = new Sequencer();
seq.add({ ...D, scale: -2 }); seq.add({ ...D, scale: -1 });
ok(seq.length === 2, 'sequencer keys');

// ── Mandelbulber import without a formula importer ──────────────────────────
section('import');
ok(typeof parseFract('[main_parameters]\nN 10;\n').main_parameters === 'object', 'parseFract');
{
  // fractalAnglesFor inverts fractalRotation, including at gimbal lock (β = ±90°).
  const { fractalAnglesFor } = await import('../engine/mbimport.js');
  const { fractalRotation } = await import('../engine/vec.js');
  const rod = (v, a) => { const l = Math.hypot(...v); const [x, y, z] = v.map(c => c / l), c = Math.cos(a), s = Math.sin(a), t = 1 - c; return [c + t * x * x, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, c + t * y * y, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, c + t * z * z]; };
  const cases = [rod([1, 0, 1], Math.PI), rod([1, 0, -1], Math.PI), rod([0, 1, 0], Math.PI / 2), rod([0, 1, 0], -Math.PI / 2), rod([1, 1, 1], 0.7), rod([0.2, -1, 0.4], 2.9)];
  for (let n = 0; n < 50; n++) cases.push(fractalRotation(Math.random() * 6 - 3, Math.random() * 3 - 1.5, Math.random() * 6 - 3));
  let worst = 0;
  for (const M of cases) { const a = fractalAnglesFor(M), R = fractalRotation(a.alpha, a.beta, a.gamma); worst = Math.max(worst, ...R.map((x, i) => Math.abs(x - M[i]))); }
  ok(worst < 1e-9, `fractalAnglesFor round-trips ${cases.length} rotations, gimbal lock included (worst ${worst.toExponential(1)})`);
}
ok(typeof importMandelbulber === 'function', 'importer loads (the template has no importFract, so the app hides the button)');

rmSync(APP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
