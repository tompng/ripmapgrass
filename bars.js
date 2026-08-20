// 遠景草の別方式実験 (方向性ぼかし版):
// 草を一様色の鉛直な棒とみなすと、遠景で見えるのは密度テクスチャを視線方位に
// 沿って平均した量になる。厳密な線積分 (プレフィックス差分) は補間誤差で不安定
// だったため、固定長の方向性ぼかしを 16 方位ぶん事前計算したテクスチャで代用する。
// グレージング投影では視線方位に沿った地面のスジが画面上でほぼ鉛直に立つので、
// 遠景では模様の方向性が合っていれば草に見える、という割り切り。

const NDIR = 16;              // 180° を等分。ぼかしは対称なので逆向きの区別は不要
const TEX = 2048;
const REG_MIN = -512, REG_SPAN = 1024;
// マクロ密度は texel 0.5m で、葉幅スケール (cm) の筋は原理的に出せない。
// 筋はタイル反復する詳細密度 (2cm/texel) が担う
const DETAIL_TEX = 1024, DETAIL_SPAN = 20.48;
const SLAB_H = 0.35;
const TER_EXTENT = 2400, TER_GRID = 512;
const GRID_N = 100, CELL = 0.5;

const hud = document.getElementById('hud');
const canvas = document.getElementById('c');

function terrainHJS(x, z) {
  return 30 * Math.sin(x * 0.0157) * Math.sin(z * 0.0157)
    + 4 * Math.sin(x * 0.05 + 1) * Math.cos(z * 0.04)
    + 0.8 * Math.sin(x * 0.21) * Math.cos(z * 0.17);
}

const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function toHalf(v) {
  _f32[0] = v;
  const x = _u32[0];
  const s = (x >> 16) & 0x8000;
  const e = (x >> 23) & 0xff;
  let m = x & 0x7fffff;
  if (e < 103) return s;
  if (e > 142) return s | 0x7c00;
  if (e < 113) { m |= 0x800000; return s | (m >> (126 - e)); }
  return s | ((e - 112) << 10) | (m >> 13);
}

function hashi(x, z) {
  let n = (Math.imul(x, 374761393) + Math.imul(z, 668265263)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  n ^= n >>> 16;
  return (n >>> 0) / 4294967296;
}
function vn(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const a = hashi(xi, zi), b = hashi(xi + 1, zi), c = hashi(xi, zi + 1), d = hashi(xi + 1, zi + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}
function sstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function genDensity() {
  const a = new Float32Array(TEX * TEX);
  const texel = REG_SPAN / TEX;
  let sum = 0;
  for (let z = 0; z < TEX; z++) {
    const wz = REG_MIN + (z + 0.5) * texel;
    for (let x = 0; x < TEX; x++) {
      const wx = REG_MIN + (x + 0.5) * texel;
      // 最小オクターブの波長はテクセル 0.5m のナイキスト (1m) より十分上に取る
      const n = 0.45 * vn(wx / 9, wz / 9)
        + 0.30 * vn(wx / 3.1 + 31.7, wz / 3.1 + 11.1)
        + 0.25 * vn(wx / 1.9 + 71.3, wz / 1.9 + 47.9);
      const r = sstep(0.36, 0.60, n);
      a[z * TEX + x] = r;
      sum += r;
    }
  }
  return { rho: a, mean: sum / (TEX * TEX) };
}

function vnT(x, z, period, seed) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const xf = x - xi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
  const wrap = t => ((t % period) + period) % period;
  const a = hashi(wrap(xi) + seed, wrap(zi) + seed * 3);
  const b = hashi(wrap(xi + 1) + seed, wrap(zi) + seed * 3);
  const c = hashi(wrap(xi) + seed, wrap(zi + 1) + seed * 3);
  const d = hashi(wrap(xi + 1) + seed, wrap(zi + 1) + seed * 3);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

// 葉幅〜株幅 (8cm/32cm) スケールのタイル詳細密度。ノイズ格子をタイル周期で
// ラップさせてシームレスにする
function genDetail() {
  const a = new Float32Array(DETAIL_TEX * DETAIL_TEX);
  const texel = DETAIL_SPAN / DETAIL_TEX;
  let sum = 0;
  for (let z = 0; z < DETAIL_TEX; z++) {
    const wz = (z + 0.5) * texel;
    for (let x = 0; x < DETAIL_TEX; x++) {
      const wx = (x + 0.5) * texel;
      const n = 0.55 * vnT(wx / 0.32, wz / 0.32, 64, 17)
        + 0.45 * vnT(wx / 0.08, wz / 0.08, 256, 71);
      const r = sstep(0.40, 0.66, n);
      a[z * DETAIL_TEX + x] = r;
      sum += r;
    }
  }
  return { det: a, mean: sum / (DETAIL_TEX * DETAIL_TEX) };
}

// ---------- WGSL ----------

const COMMON = /* wgsl */`
const PI = 3.141592653589793;
fn h11(n: f32) -> f32 { return fract(sin(n) * 43758.5453123); }
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123); }

fn terrainH(p: vec2f) -> f32 {
  return 30.0*sin(p.x*0.0157)*sin(p.y*0.0157)
       + 4.0*sin(p.x*0.05 + 1.0)*cos(p.y*0.04)
       + 0.8*sin(p.x*0.21)*cos(p.y*0.17);
}
fn terrainN(p: vec2f) -> vec3f {
  let dx = 30.0*0.0157*cos(p.x*0.0157)*sin(p.y*0.0157)
         + 4.0*0.05*cos(p.x*0.05 + 1.0)*cos(p.y*0.04)
         + 0.8*0.21*cos(p.x*0.21)*cos(p.y*0.17);
  let dz = 30.0*0.0157*sin(p.x*0.0157)*cos(p.y*0.0157)
         - 4.0*0.04*sin(p.x*0.05 + 1.0)*sin(p.y*0.04)
         - 0.8*0.17*sin(p.x*0.21)*sin(p.y*0.17);
  return normalize(vec3f(-dx, 1.0, -dz));
}

struct BParams { height: f32, halfW: f32, bend: f32, yaw: f32, varh: f32 }
fn bladeParams(s1: f32, s2: f32) -> BParams {
  var p: BParams;
  p.height = 0.22 + 0.28*h11(s1*37.7 + 0.17);
  p.halfW  = 0.014 + 0.014*h11(s1*61.3 + 0.71);
  p.bend   = 0.12 + 0.50*h11(s2*47.1 + 0.29);
  p.yaw    = h11(s2*91.7 + 0.53)*2.0*PI;
  p.varh   = h11(s1*53.3 + s2*29.9);
  return p;
}
fn bladeVertex(base: vec3f, up: vec3f, t: f32, side: f32, bp: BParams, windOff: vec3f) -> vec3f {
  let yaw3 = vec3f(cos(bp.yaw), 0.0, sin(bp.yaw));
  var bendDir = yaw3 - up*dot(yaw3, up);
  let l2 = dot(bendDir, bendDir);
  bendDir = select(normalize(bendDir), vec3f(1.0, 0.0, 0.0), l2 < 1e-5);
  let sideDir = normalize(cross(up, bendDir));
  var p = base + sideDir*(side*bp.halfW*(1.0 - 0.75*t*t));
  p += up*(bp.height*t*(1.0 - 0.22*bp.bend*t*t));
  p += bendDir*(bp.bend*bp.height*t*t);
  p += windOff*(t*t);
  return p;
}

const ROOT_COL  = vec3f(0.09, 0.19, 0.04);
const TIP_COL   = vec3f(0.42, 0.60, 0.18);
const DRY_COL   = vec3f(1.25, 1.10, 0.55);
const SUN_COL   = vec3f(1.20, 1.08, 0.88);
const SKY_AMB   = vec3f(0.30, 0.42, 0.58);
const TRANS_COL = vec3f(0.45, 0.60, 0.16);

fn grassAlbedo(t: f32, varh: f32) -> vec3f {
  return mix(ROOT_COL, TIP_COL, t) * mix(vec3f(1.0), DRY_COL, varh*0.45);
}
fn grassAO(t: f32) -> f32 { return 0.25 + 0.75*t; }
fn shadeGrass(alb: vec3f, N: vec3f, V: vec3f, sun: vec3f, t: f32, ao: f32) -> vec3f {
  let ndl = max(dot(N, sun), 0.0);
  var c = alb * (SUN_COL*ndl*ao + SKY_AMB*ao*0.9);
  c += TRANS_COL * pow(max(dot(V, sun), 0.0), 6.0) * t * ao * 0.5;
  return c;
}
fn patchTint(p: vec2f) -> vec3f {
  let n = 0.5 + 0.5*sin(p.x*0.043 + sin(p.y*0.031)*2.0)*sin(p.y*0.037 + sin(p.x*0.049)*2.0);
  return mix(vec3f(0.88, 1.0, 0.82), vec3f(1.18, 1.08, 0.68), n);
}
fn groundAlbedo(p: vec2f) -> vec3f {
  let n = 0.5 + 0.5*sin(p.x*2.3)*sin(p.y*2.9);
  return vec3f(0.20, 0.16, 0.10) * (0.8 + 0.4*n);
}
fn tonemap(c: vec3f) -> vec3f {
  return pow(c / (1.0 + c*0.35), vec3f(1.0/2.2));
}
fn applyFog(c: vec3f, dist: f32, vdotl: f32) -> vec3f {
  let f = 1.0 - exp(-pow(dist*0.0011, 1.4));
  let fog = vec3f(0.72, 0.80, 0.90) + vec3f(0.9, 0.7, 0.4)*pow(max(vdotl, 0.0), 5.0)*0.35;
  return mix(c, fog, clamp(f, 0.0, 1.0));
}

struct U {
  viewProj: mat4x4f,
  camPos: vec4f,    // w: time
  camFwd: vec4f,    // w: tanHalfFov
  camRight: vec4f,  // w: aspect
  camUp: vec4f,     // w: windOn
  sunDir: vec4f,    // w: barsOn
  par: vec4f,       // grassR0, grassR1, kOpacity, slabH
  grid: vec4f,      // cellSize, gridN, originX, originZ
  misc: vec4f,      // bladesPerCell, rhoMean, geomOn, -
  misc2: vec4f,     // detailMean, flatGround, -, -
}
fn rhoUV(p: vec2f) -> vec2f {
  return (p - vec2f(${REG_MIN}.0)) / ${REG_SPAN}.0;
}
`;

const SCENE_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var rhoTex: texture_2d<f32>;
@group(0) @binding(3) var farr: texture_2d_array<f32>;
@group(0) @binding(4) var detailArr: texture_2d_array<f32>;
@group(0) @binding(5) var sampR: sampler;

// --- sky ---
struct SkyOut { @builtin(position) pos: vec4f, @location(0) ndc: vec2f }
@vertex fn vsSky(@builtin(vertex_index) vi: u32) -> SkyOut {
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  var o: SkyOut;
  o.pos = vec4f(x, y, 0.99999, 1.0);
  o.ndc = vec2f(x, y);
  return o;
}
@fragment fn fsSky(in: SkyOut) -> @location(0) vec4f {
  let tf = u.camFwd.w;
  let dir = normalize(u.camFwd.xyz + u.camRight.xyz*(in.ndc.x*tf*u.camRight.w) + u.camUp.xyz*(in.ndc.y*tf));
  let hor = vec3f(0.72, 0.80, 0.90);
  let zen = vec3f(0.30, 0.50, 0.83);
  var c = mix(hor, zen, pow(clamp(dir.y, 0.0, 1.0), 0.55));
  let sd = max(dot(dir, u.sunDir.xyz), 0.0);
  c += vec3f(1.0, 0.9, 0.7)*(pow(sd, 800.0)*6.0 + pow(sd, 8.0)*0.12);
  return vec4f(tonemap(c), 1.0);
}

// --- terrain ---
struct TOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f }
@vertex fn vsTerrain(@builtin(vertex_index) vi: u32) -> TOut {
  let gv = ${TER_GRID + 1}u;
  let i = f32(vi % gv);
  let j = f32(vi / gv);
  let x = (i/${TER_GRID}.0 - 0.5) * ${TER_EXTENT}.0;
  let z = (j/${TER_GRID}.0 - 0.5) * ${TER_EXTENT}.0;
  let wp = vec3f(x, terrainH(vec2f(x, z)), z);
  var o: TOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  return o;
}
@fragment fn fsTerrain(in: TOut) -> @location(0) vec4f {
  let wp = in.wp;
  let N = terrainN(wp.xz);
  let toF = wp - u.camPos.xyz;
  let dist = length(toF);
  let V = toF / dist;
  let uv = rhoUV(wp.xz);
  let edge = max(abs(wp.x), abs(wp.z));
  let regFade = 1.0 - smoothstep(${REG_SPAN / 2 - 40}.0, ${REG_SPAN / 2}.0, edge);
  let ndl = max(dot(N, u.sunDir.xyz), 0.0);
  let rho = mix(u.misc.y, textureSample(rhoTex, samp, uv).r, regFade);
  // groundAlbedo の手続きノイズはミップを持たないため、遠方でモアレになる前に均す
  let dirt = mix(groundAlbedo(wp.xz*0.7), vec3f(0.20, 0.16, 0.10), min(dist*0.01, 1.0));
  var gAlb = mix(dirt, ROOT_COL*1.4, clamp(rho*0.85 + 0.05, 0.0, 1.0)) * patchTint(wp.xz);
  // 単色地面モード: 方向性レイヤーの効果と地面の色変化を切り分ける検証用
  if (u.misc2.y > 0.5) { gAlb = vec3f(0.17, 0.14, 0.11); }
  var c = gAlb * (SUN_COL*ndl + SKY_AMB*0.9);
  if (u.sunDir.w > 0.5) {
    // 視線方位に沿ってぼかした密度を引く。方位量子化は隣接2層の lerp
    // (ぼかしは対称なので 180° 周期、符号処理は不要)
    var rh = V.xz;
    let lh = length(rh);
    rh = select(rh / lh, vec2f(1.0, 0.0), lh < 1e-5);
    var tm = atan2(rh.y, rh.x);
    if (tm < 0.0) { tm += PI; }
    var i0 = floor(tm / (PI / ${NDIR}.0));
    let fw = tm / (PI / ${NDIR}.0) - i0;
    if (i0 > ${NDIR - 1}.5) { i0 = ${NDIR - 1}.0; }
    var i1 = i0 + 1.0;
    if (i1 > ${NDIR - 1}.5) { i1 = 0.0; }
    let b0 = textureSample(farr, samp, uv, i32(i0)).r;
    let b1 = textureSample(farr, samp, uv, i32(i1)).r;
    var rd = mix(u.misc.y, mix(b0, b1, fw), regFade);
    // ぼかしで落ちたコントラストを戻す
    rd = clamp((rd - 0.30) * 1.7 + 0.30, 0.0, 1.3);
    // 葉幅スケールの縦筋はマクロ密度 (texel 0.5m) では出ないため、
    // cm スケールのタイル詳細密度 (同じ16方位ぼかし済み) を乗算する
    let duv = wp.xz / ${DETAIL_SPAN};
    let d0 = textureSample(detailArr, sampR, duv, i32(i0)).r;
    let d1 = textureSample(detailArr, sampR, duv, i32(i1)).r;
    let detN = mix(d0, d1, fw) / max(u.misc2.x, 1e-3);
    rd = rd * (0.35 + 0.65 * detN);
    // 不透明度: 密度 × グレージングでの見かけ光路長 (足元線分長は固定上限でクランプ)
    let sinG = clamp(abs(dot(V, N)), 0.02, 1.0);
    let L = clamp(u.par.w * sqrt(1.0 - sinG*sinG) / sinG, 0.1, 12.0);
    let tau = u.par.z * rd * L;
    var alpha = 1.0 - exp(-tau);
    if (u.misc.z > 0.5) {
      // ジオメトリ草の圏内ではベールを引っ込めて葉のコントラストを保つ
      alpha *= 0.25 + 0.75*smoothstep(u.par.x, u.par.y, distance(wp.xz, u.camPos.xz));
    }
    // 高密度側でも飽和しない線形カーブにして、密草地帯の中の濃淡を残す
    let shade = 1.35 - 0.5 * clamp(rd, 0.0, 1.3);
    var galb = mix(ROOT_COL, TIP_COL, 0.6) * shade;
    if (u.misc2.y < 0.5) { galb *= patchTint(wp.xz); }
    var glit = galb * (SUN_COL*ndl*0.9 + SKY_AMB*0.75);
    glit += TRANS_COL * pow(max(dot(V, u.sunDir.xyz), 0.0), 6.0) * 0.25;
    c = mix(c, glit, alpha);
  }
  c = applyFog(c, dist, dot(V, u.sunDir.xyz));
  return vec4f(tonemap(c), 1.0);
}

// --- geometry grass ---
struct GOut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) tv: vec2f }
@vertex fn vsGrass(@location(0) vt: vec2f, @builtin(instance_index) ii: u32) -> GOut {
  let bpc = u32(u.misc.x);
  let gridN = u32(u.grid.y);
  let cell = ii / bpc;
  let k = f32(ii % bpc);
  let ci = f32(cell % gridN);
  let cj = f32(cell / gridN);
  let cs = u.grid.x;
  let s1 = h21(vec2f(ci*1.618 + k*17.77, cj*2.19 + k*0.37));
  let s2 = h21(vec2f(cj*3.11 + k*9.13, ci*1.71 + k*1.13));
  let bx = u.grid.z + (ci + h11(s1*11.3 + 0.13))*cs;
  let bz = u.grid.w + (cj + h11(s2*7.9 + 0.57))*cs;
  let base = vec3f(bx, terrainH(vec2f(bx, bz)), bz);
  let d = distance(vec2f(bx, bz), u.camPos.xz);
  let fade = 1.0 - smoothstep(u.par.x, u.par.y, d);
  // 密度テクスチャとの整合: ρ が薄い場所はジオメトリ草も間引く
  let rho = textureSampleLevel(rhoTex, samp, rhoUV(vec2f(bx, bz)), 0.0).r;
  let keep = step(h11(s1*23.7 + s2*13.1), rho*0.85 + 0.15);
  var bp = bladeParams(s1, s2);
  bp.height *= fade * keep;
  bp.halfW *= fade * keep;
  let up = terrainN(vec2f(bx, bz));
  var windOff = vec3f(0.0);
  if (u.camUp.w > 0.5) {
    let time = u.camPos.w;
    let wamp = 0.10*sin(time*1.9 + bx*0.35 + bz*0.22) + 0.05*sin(time*3.7 + bz*0.53 + bx*0.31);
    windOff = vec3f(0.86, 0.0, 0.5) * wamp;
  }
  let p = bladeVertex(base, up, vt.x, vt.y, bp, windOff);
  var o: GOut;
  o.pos = u.viewProj * vec4f(p, 1.0);
  o.wp = p;
  o.tv = vec2f(vt.x, bp.varh);
  return o;
}
@fragment fn fsGrass(in: GOut) -> @location(0) vec4f {
  let N = terrainN(in.wp.xz);
  let toF = in.wp - u.camPos.xyz;
  let dist = length(toF);
  let V = toF / dist;
  let alb = grassAlbedo(in.tv.x, in.tv.y) * patchTint(in.wp.xz);
  var c = shadeGrass(alb, N, V, u.sunDir.xyz, in.tv.x, grassAO(in.tv.x));
  c = applyFog(c, dist, dot(V, u.sunDir.xyz));
  return vec4f(tonemap(c), 1.0);
}

// --- 16方向ぼかしテクスチャのビューア (4x4 グリッド、赤線が各層のぼかし方向) ---
struct OOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vsOverlay(@builtin(vertex_index) vi: u32) -> OOut {
  let corner = vec2f(f32(vi % 2u), f32((vi / 2u) % 2u));
  let hw = 0.9 / u.camRight.w;
  var o: OOut;
  o.pos = vec4f(mix(-hw, hw, corner.x), mix(-0.9, 0.9, corner.y), 0.0, 1.0);
  o.uv = vec2f(corner.x, 1.0 - corner.y);
  return o;
}
@fragment fn fsOverlay(in: OOut) -> @location(0) vec4f {
  let tile = min(floor(in.uv * 4.0), vec2f(3.0));
  let layer = i32(tile.y * 4.0 + tile.x);
  let tuv = fract(in.uv * 4.0);
  // 全域を縮小するとぼかし長 (数m) が見えないので、カメラ位置周辺の
  // 同一領域 (約80m四方) を全タイル共通で拡大表示する
  let cuv = rhoUV(u.camPos.xz) + (tuv - vec2f(0.5)) * 0.08;
  let v = textureSampleLevel(farr, samp, cuv, layer, 0.0).r;
  var c = vec3f(clamp((v - 0.05) * 1.5, 0.0, 1.0)) * vec3f(0.6, 0.8, 0.45);
  let th = f32(layer) * PI / ${NDIR}.0;
  let dirv = vec2f(cos(th), sin(th));
  let p = tuv - vec2f(0.5);
  if (abs(dot(p, vec2f(-dirv.y, dirv.x))) < 0.008 && abs(dot(p, dirv)) < 0.13) {
    c = mix(c, vec3f(1.0, 0.25, 0.2), 0.85);
  }
  if (min(tuv.x, tuv.y) < 0.008 || max(tuv.x, tuv.y) > 0.992) {
    c = vec3f(0.05);
  }
  return vec4f(pow(c, vec3f(1.0/2.2)), 1.0);
}
`;

const BLUR_WGSL = /* wgsl */`
struct BU { dir: vec4f }
@group(0) @binding(0) var<uniform> bu: BU;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var s2: sampler;
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  return vec4f(x, y, 0.0, 1.0);
}
@fragment fn fsBlur(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / vec2f(textureDimensions(src));
  var acc = 0.0;
  var wsum = 0.0;
  for (var t = -8; t <= 8; t++) {
    let w = exp(-f32(t*t) * 0.05);
    acc += textureSampleLevel(src, s2, uv + bu.dir.xy * f32(t), 0.0).r * w;
    wsum += w;
  }
  return vec4f(acc / wsum, 0.0, 0.0, 1.0);
}
@fragment fn fsMip(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dim = textureDimensions(src);
  let base = vec2u(fc.xy) * 2u;
  var acc = vec4f(0.0);
  for (var j = 0u; j < 2u; j++) {
    for (var i = 0u; i < 2u; i++) {
      acc += textureLoad(src, min(base + vec2u(i, j), dim - vec2u(1u)), 0);
    }
  }
  return acc / 4.0;
}
`;

// ---------- matrices ----------

function perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect; m[5] = f;
  m[10] = far / (near - far); m[11] = -1;
  m[14] = near * far / (near - far);
  return m;
}
function mul4(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
    o[c * 4 + r] = s;
  }
  return o;
}

// ---------- main ----------

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU unsupported');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no GPU adapter');
  const device = await adapter.requestDevice();
  device.lost.then(info => {
    console.error('device lost:', info.reason, info.message);
    hud.textContent = 'DEVICE LOST: ' + info.reason + ' ' + info.message;
  });
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  // --- density texture ---
  const t0 = performance.now();
  const { rho, mean } = genDensity();
  const densMs = performance.now() - t0;

  const mipCount = Math.log2(TEX) + 1;
  const rhoTex = device.createTexture({
    size: [TEX, TEX], format: 'r16float', mipLevelCount: mipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
  const farrTex = device.createTexture({
    size: [TEX, TEX, NDIR], format: 'r16float', mipLevelCount: mipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  {
    const h = new Uint16Array(TEX * TEX);
    for (let i = 0; i < h.length; i++) h[i] = toHalf(rho[i]);
    device.queue.writeTexture({ texture: rhoTex }, h, { bytesPerRow: TEX * 2, rowsPerImage: TEX }, [TEX, TEX, 1]);
  }

  const samp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 8,
  });
  const sampR = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8,
  });

  const { det, mean: detMean } = genDetail();
  const detMipCount = Math.log2(DETAIL_TEX) + 1;
  const detailTex = device.createTexture({
    size: [DETAIL_TEX, DETAIL_TEX], format: 'r16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  const detailArr = device.createTexture({
    size: [DETAIL_TEX, DETAIL_TEX, NDIR], format: 'r16float', mipLevelCount: detMipCount,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });
  {
    const h = new Uint16Array(DETAIL_TEX * DETAIL_TEX);
    for (let i = 0; i < h.length; i++) h[i] = toHalf(det[i]);
    device.queue.writeTexture({ texture: detailTex }, h, { bytesPerRow: DETAIL_TEX * 2, rowsPerImage: DETAIL_TEX }, [DETAIL_TEX, DETAIL_TEX, 1]);
  }

  // --- 16方向ぼかし + ミップ生成 (GPU) ---
  const t1 = performance.now();
  device.pushErrorScope('validation');
  {
    const blurMod = device.createShaderModule({ code: BLUR_WGSL });
    const blurPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blurMod, entryPoint: 'vsFull' },
      fragment: { module: blurMod, entryPoint: 'fsBlur', targets: [{ format: 'r16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    const mipPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blurMod, entryPoint: 'vsFull' },
      fragment: { module: blurMod, entryPoint: 'fsMip', targets: [{ format: 'r16float' }] },
      primitive: { topology: 'triangle-list' },
    });
    const enc = device.createCommandEncoder();
    const blurDirs = (srcTex, dstTex, stepM, span, blurSamp) => {
      for (let dir = 0; dir < NDIR; dir++) {
        const th = dir * Math.PI / NDIR;
        const bu = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(bu, 0, new Float32Array([
          Math.cos(th) * stepM / span, Math.sin(th) * stepM / span, 0, 0,
        ]));
        const bind = device.createBindGroup({
          layout: blurPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: bu } },
            { binding: 1, resource: srcTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 2, resource: blurSamp },
          ],
        });
        const pass = enc.beginRenderPass({
          colorAttachments: [{
            view: dstTex.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: dir, arrayLayerCount: 1 }),
            loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store',
          }],
        });
        pass.setPipeline(blurPipe);
        pass.setBindGroup(0, bind);
        pass.draw(3);
        pass.end();
      }
    };
    // マクロ: タップ間隔 0.7m ±8。詳細: 0.08m ±8 (葉幅 8cm に対して縦横比 ~8:1 の筋)
    blurDirs(rhoTex, farrTex, 0.7, REG_SPAN, samp);
    blurDirs(detailTex, detailArr, 0.08, DETAIL_SPAN, sampR);
    const genMips = (tex, layers, levels) => {
      for (let layer = 0; layer < layers; layer++) {
        for (let lv = 1; lv < levels; lv++) {
          const bind = device.createBindGroup({
            layout: mipPipe.getBindGroupLayout(0),
            entries: [{
              binding: 1,
              resource: tex.createView({ dimension: '2d', baseMipLevel: lv - 1, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }),
            }],
          });
          const pass = enc.beginRenderPass({
            colorAttachments: [{
              view: tex.createView({ dimension: '2d', baseMipLevel: lv, mipLevelCount: 1, baseArrayLayer: layer, arrayLayerCount: 1 }),
              loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store',
            }],
          });
          pass.setPipeline(mipPipe);
          pass.setBindGroup(0, bind);
          pass.draw(3);
          pass.end();
        }
      }
    };
    genMips(rhoTex, 1, mipCount);
    genMips(farrTex, NDIR, mipCount);
    genMips(detailArr, NDIR, detMipCount);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  }
  device.popErrorScope().then(e => { if (e) console.error('bake validation:', e.message); });
  const blurMs = performance.now() - t1;

  // --- scene pipelines (MSAA, canvas直描き) ---
  const sceneMod = device.createShaderModule({ code: SCENE_WGSL });
  const MSAA = 4;
  const layoutA = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const uBuf = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bindA = device.createBindGroup({
    layout: layoutA,
    entries: [
      { binding: 0, resource: { buffer: uBuf } },
      { binding: 1, resource: samp },
      { binding: 2, resource: rhoTex.createView() },
      { binding: 3, resource: farrTex.createView({ dimension: '2d-array' }) },
      { binding: 4, resource: detailArr.createView({ dimension: '2d-array' }) },
      { binding: 5, resource: sampR },
    ],
  });
  const pLayoutA = device.createPipelineLayout({ bindGroupLayouts: [layoutA] });
  const targets = [{ format }];
  const depthOn = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };

  const skyPipe = device.createRenderPipeline({
    layout: pLayoutA,
    vertex: { module: sceneMod, entryPoint: 'vsSky' },
    fragment: { module: sceneMod, entryPoint: 'fsSky', targets },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    multisample: { count: MSAA },
  });
  const terrainPipe = device.createRenderPipeline({
    layout: pLayoutA,
    vertex: { module: sceneMod, entryPoint: 'vsTerrain' },
    fragment: { module: sceneMod, entryPoint: 'fsTerrain', targets },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthOn,
    multisample: { count: MSAA },
  });
  const grassPipe = device.createRenderPipeline({
    layout: pLayoutA,
    vertex: {
      module: sceneMod, entryPoint: 'vsGrass',
      buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] }],
    },
    fragment: { module: sceneMod, entryPoint: 'fsGrass', targets },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthOn,
    multisample: { count: MSAA },
  });
  const overlayPipe = device.createRenderPipeline({
    layout: pLayoutA,
    vertex: { module: sceneMod, entryPoint: 'vsOverlay' },
    fragment: { module: sceneMod, entryPoint: 'fsOverlay', targets },
    primitive: { topology: 'triangle-strip' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    multisample: { count: MSAA },
  });

  // --- meshes ---
  const bladeMesh = device.createBuffer({ size: 9 * 2 * 4, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
  new Float32Array(bladeMesh.getMappedRange()).set([
    0, -1, 0, 1, 0.25, -1, 0.25, 1, 0.5, -1, 0.5, 1, 0.75, -1, 0.75, 1, 1, 0,
  ]);
  bladeMesh.unmap();
  const bladeIdx = device.createBuffer({ size: 44, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
  new Uint16Array(bladeIdx.getMappedRange()).set([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6, 6, 5, 7, 6, 7, 8]);
  bladeIdx.unmap();

  const terIdx = new Uint32Array(TER_GRID * TER_GRID * 6);
  {
    let o = 0;
    for (let j = 0; j < TER_GRID; j++) for (let i = 0; i < TER_GRID; i++) {
      const a = j * (TER_GRID + 1) + i;
      terIdx[o++] = a; terIdx[o++] = a + 1; terIdx[o++] = a + TER_GRID + 1;
      terIdx[o++] = a + TER_GRID + 1; terIdx[o++] = a + 1; terIdx[o++] = a + TER_GRID + 2;
    }
  }
  const terIdxBuf = device.createBuffer({ size: terIdx.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
  new Uint32Array(terIdxBuf.getMappedRange()).set(terIdx);
  terIdxBuf.unmap();

  // --- state ---
  const state = {
    pos: [0, 0, 240], yaw: 0.55, pitch: -0.06,
    keys: new Set(),
    geomOn: true, barsOn: true, windOn: true, rhoOverlay: false, paused: false, flatGround: false,
    bpc: 32, r1: 24, sunAz: 2.4, sunEl: 0.66, kOpacity: 2.0,
    time: 0, fps: 0,
  };
  state.pos[1] = terrainHJS(0, 240) + 1.7;

  let msaaTex = null, depthTex = null, curW = 0, curH = 0;
  function ensureTargets(w, h) {
    if (w === curW && h === curH) return;
    curW = w; curH = h;
    msaaTex?.destroy(); depthTex?.destroy();
    msaaTex = device.createTexture({ size: [w, h], format, sampleCount: MSAA, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    depthTex = device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: MSAA, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  // --- input ---
  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('mousedown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('mouseup', () => dragging = false);
  window.addEventListener('mousemove', e => {
    if (!dragging) return;
    state.yaw += (e.clientX - lastX) * 0.003;
    state.pitch -= (e.clientY - lastY) * 0.003;
    state.pitch = Math.max(-1.5, Math.min(1.5, state.pitch));
    lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('keydown', e => {
    const k = e.key.toLowerCase();
    state.keys.add(k);
    if (k === 'g') state.geomOn = !state.geomOn;
    if (k === 'b') state.barsOn = !state.barsOn;
    if (k === 't') state.rhoOverlay = !state.rhoOverlay;
    if (k === 'v') state.windOn = !state.windOn;
    if (k === 'p') state.paused = !state.paused;
    if (k === 'n') state.flatGround = !state.flatGround;
    if (k === '1') state.sunAz -= 0.15;
    if (k === '2') state.sunAz += 0.15;
    if (k === '3') state.bpc = Math.max(4, state.bpc / 2);
    if (k === '4') state.bpc = Math.min(64, state.bpc * 2);
    if (k === '5') state.r1 = Math.max(6, state.r1 - 3);
    if (k === '6') state.r1 = Math.min(24, state.r1 + 3);
    if (k === '7') state.kOpacity = Math.max(0.2, state.kOpacity / 1.3);
    if (k === '8') state.kOpacity = Math.min(30, state.kOpacity * 1.3);
  });
  window.addEventListener('keyup', e => state.keys.delete(e.key.toLowerCase()));

  window.demo = {
    state,
    setCam(x, y, z, yaw, pitch) {
      state.pos = [x, y, z]; state.yaw = yaw; state.pitch = pitch;
    },
    terrainH: terrainHJS,
    async readTex(tex, layer, x, y, w) {
      const buf = device.createBuffer({ size: Math.max(w * 2, 256), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex, origin: [x, y, layer] },
        { buffer: buf, bytesPerRow: Math.max(w * 2, 256) },
        [w, 1, 1]);
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const h = new Uint16Array(buf.getMappedRange().slice(0, w * 2));
      const out = [...h].map(v => {
        const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, m = v & 0x3ff;
        if (e === 0) return s * m * Math.pow(2, -24);
        return s * (1 + m / 1024) * Math.pow(2, e - 15);
      });
      buf.unmap();
      return out;
    },
    tex: { get rho() { return rhoTex; }, get farr() { return farrTex; }, get detail() { return detailArr; } },
  };

  // --- frame loop ---
  const uData = new Float32Array(52);
  let prev = performance.now();
  let fpsAcc = 0, fpsN = 0, fpsT = 0;

  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;
    if (!state.paused) state.time += dt;
    fpsAcc += dt; fpsN++;
    if ((fpsT += dt) > 0.5) { state.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; fpsT = 0; }

    const speed = state.keys.has('shift') ? 60 : 12;
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    let mx = 0, mz = 0, my = 0;
    if (state.keys.has('w')) { mx += sy; mz -= cy; }
    if (state.keys.has('s')) { mx -= sy; mz += cy; }
    if (state.keys.has('d')) { mx += cy; mz += sy; }
    if (state.keys.has('a')) { mx -= cy; mz -= sy; }
    if (state.keys.has('r')) my += 1;
    if (state.keys.has('f')) my -= 1;
    state.pos[0] += mx * speed * dt;
    state.pos[2] += mz * speed * dt;
    state.pos[1] += my * speed * dt;
    const minY = terrainHJS(state.pos[0], state.pos[2]) + 0.6;
    if (state.pos[1] < minY) state.pos[1] = minY;

    const dpr = Math.min(devicePixelRatio, 2);
    const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ensureTargets(w, h);

    const cp = Math.cos(state.pitch), sp = Math.sin(state.pitch);
    const fwd = [sy * cp, sp, -cy * cp];
    const right = [cy, 0, sy];
    const up = [
      right[1] * fwd[2] - right[2] * fwd[1],
      right[2] * fwd[0] - right[0] * fwd[2],
      right[0] * fwd[1] - right[1] * fwd[0],
    ];
    const pos = state.pos;
    const view = new Float32Array([
      right[0], up[0], -fwd[0], 0,
      right[1], up[1], -fwd[1], 0,
      right[2], up[2], -fwd[2], 0,
      -(right[0] * pos[0] + right[1] * pos[1] + right[2] * pos[2]),
      -(up[0] * pos[0] + up[1] * pos[1] + up[2] * pos[2]),
      (fwd[0] * pos[0] + fwd[1] * pos[1] + fwd[2] * pos[2]),
      1,
    ]);
    const fovY = 55 * Math.PI / 180;
    const aspect = w / h;
    const viewProj = mul4(perspective(fovY, aspect, 0.1, 4000), view);
    const sun = [
      Math.cos(state.sunEl) * Math.cos(state.sunAz),
      Math.sin(state.sunEl),
      Math.cos(state.sunEl) * Math.sin(state.sunAz),
    ];
    const half = GRID_N * CELL / 2;
    const ox = Math.floor((pos[0] - half) / CELL) * CELL;
    const oz = Math.floor((pos[2] - half) / CELL) * CELL;

    uData.set(viewProj, 0);
    uData.set([pos[0], pos[1], pos[2], state.time], 16);
    uData.set([fwd[0], fwd[1], fwd[2], Math.tan(fovY / 2)], 20);
    uData.set([right[0], right[1], right[2], aspect], 24);
    uData.set([up[0], up[1], up[2], state.windOn ? 1 : 0], 28);
    uData.set([sun[0], sun[1], sun[2], state.barsOn ? 1 : 0], 32);
    uData.set([state.r1 * 0.7, state.r1, state.kOpacity, SLAB_H], 36);
    uData.set([CELL, GRID_N, ox, oz], 40);
    uData.set([state.bpc, mean, state.geomOn ? 1 : 0, 0], 44);
    uData.set([detMean, state.flatGround ? 1 : 0, 0, 0], 48);
    device.queue.writeBuffer(uBuf, 0, uData);

    const enc = device.createCommandEncoder();
    const pass = enc.beginRenderPass({
      colorAttachments: [{
        view: msaaTex.createView(), resolveTarget: ctx.getCurrentTexture().createView(),
        loadOp: 'clear', clearValue: [0, 0, 0, 1], storeOp: 'discard',
      }],
      depthStencilAttachment: {
        view: depthTex.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard',
      },
    });
    pass.setBindGroup(0, bindA);
    pass.setPipeline(skyPipe);
    pass.draw(3);
    pass.setPipeline(terrainPipe);
    pass.setIndexBuffer(terIdxBuf, 'uint32');
    pass.drawIndexed(terIdx.length);
    if (state.geomOn) {
      pass.setPipeline(grassPipe);
      pass.setVertexBuffer(0, bladeMesh);
      pass.setIndexBuffer(bladeIdx, 'uint16');
      pass.drawIndexed(21, GRID_N * GRID_N * state.bpc);
    }
    if (state.rhoOverlay) {
      pass.setPipeline(overlayPipe);
      pass.draw(4);
    }
    pass.end();
    device.queue.submit([enc.finish()]);

    const blades = state.geomOn ? GRID_N * GRID_N * state.bpc : 0;
    hud.textContent =
      `fps ${state.fps.toFixed(0)}  density ${densMs.toFixed(0)}ms  blur16 ${blurMs.toFixed(0)}ms  blades ${(blades / 1000).toFixed(0)}k\n` +
      `geom[G] ${state.geomOn ? 'on' : 'off'}  bars[B] ${state.barsOn ? 'on' : 'off'}  ` +
      `wind[V] ${state.windOn ? 'on' : 'off'}  rho[T] ${state.rhoOverlay ? 'on' : 'off'}  flat[N] ${state.flatGround ? 'on' : 'off'}\n` +
      `radius[5/6] ${state.r1}m  density[3/4] ${state.bpc}/cell  opacity[7/8] ${state.kOpacity.toFixed(1)}  sun[1/2] ${(state.sunAz * 180 / Math.PI).toFixed(0)}°\n` +
      `drag:look  WASD:move  R/F:up/down  Shift:fast  P:pause`;

    requestAnimationFrame(frameWrap);
  }
  function frameWrap(now) {
    try {
      frame(now);
    } catch (e) {
      console.error(e);
      hud.textContent = 'frame error: ' + ((e && e.message) || e);
    }
  }
  requestAnimationFrame(frameWrap);
}

main().catch(e => {
  console.error(e);
  const el = document.getElementById('err');
  el.style.display = 'grid';
  el.textContent = String(e);
});
