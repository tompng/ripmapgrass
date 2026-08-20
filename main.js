// 遠景草LOD実験: 「接線角が高さに線形な曲面に生やしたジオメトリ草を正投影でキャプチャすると、
// テクスチャの v 軸がグレージング角のカタログになる」というアイデアの検証。
// キャプチャは色ではなく属性 (R: blade t, G: AO, B: variation, A: coverage) を焼き、
// ライティングは実行時に近景ジオメトリ草と同じ式で行う。

const PHI0 = 0.025;           // 最小グレージング角 (θ→0 は無限の助走が要るためクランプ)
const PHI1 = 1.53;
const DPHI = PHI1 - PHI0;
const H_CAP = 10;             // キャプチャ窓の世界高さ [m]
const W_CAP = 8;              // テクスチャ u 方向の繰り返し幅 [m]
const CACHE_W = 2048, CACHE_H = 1024;
const SS = 4;                 // キャプチャのスーパーサンプル倍率 (coverage の小数化)
const BAKE_DENSITY = 128;     // [本/m^2] 実行時の既定密度 (32本/0.25m^2セル) と一致させる
const TER_EXTENT = 2400, TER_GRID = 512;
const GRID_N = 100, CELL = 0.5;

const hud = document.getElementById('hud');
const canvas = document.getElementById('c');

function terrainHJS(x, z) {
  return 30 * Math.sin(x * 0.0157) * Math.sin(z * 0.0157)
    + 4 * Math.sin(x * 0.05 + 1) * Math.cos(z * 0.04)
    + 0.8 * Math.sin(x * 0.21) * Math.cos(z * 0.17);
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
// 株ごとの variation は遠距離で平均化されて単調になるため、
// ワールド座標アンカーの大スケール色ムラを近景・遠景共通で掛ける
fn patchTint(p: vec2f) -> vec3f {
  let n = 0.5 + 0.5*sin(p.x*0.043 + sin(p.y*0.031)*2.0)*sin(p.y*0.037 + sin(p.x*0.049)*2.0);
  return mix(vec3f(0.88, 1.0, 0.82), vec3f(1.18, 1.08, 0.68), n);
}
fn grassAO(t: f32) -> f32 { return 0.25 + 0.75*t; }
fn shadeGrass(alb: vec3f, N: vec3f, V: vec3f, sun: vec3f, t: f32, ao: f32) -> vec3f {
  let ndl = max(dot(N, sun), 0.0);
  var c = alb * (SUN_COL*ndl*ao + SKY_AMB*ao*0.9);
  c += TRANS_COL * pow(max(dot(V, sun), 0.0), 6.0) * t * ao * 0.5;
  return c;
}
fn groundAlbedo(p: vec2f) -> vec3f {
  let n = 0.5 + 0.5*sin(p.x*2.3)*sin(p.y*2.9);
  return vec3f(0.20, 0.16, 0.10) * (0.8 + 0.4*n);
}
fn shadeGround(alb: vec3f, N: vec3f, sun: vec3f) -> vec3f {
  return alb * (SUN_COL*max(dot(N, sun), 0.0) + SKY_AMB*0.9);
}
fn tonemap(c: vec3f) -> vec3f {
  return pow(c / (1.0 + c*0.35), vec3f(1.0/2.2));
}
fn applyFog(c: vec3f, dist: f32, vdotl: f32) -> vec3f {
  let f = 1.0 - exp(-pow(dist*0.0011, 1.4));
  let fog = vec3f(0.72, 0.80, 0.90) + vec3f(0.9, 0.7, 0.4)*pow(max(vdotl, 0.0), 5.0)*0.35;
  return mix(c, fog, clamp(f, 0.0, 1.0));
}
`;

const RUNTIME_WGSL = COMMON + /* wgsl */`
struct U {
  viewProj: mat4x4f,
  camPos: vec4f,    // w: time
  camFwd: vec4f,    // w: tanHalfFov
  camRight: vec4f,  // w: aspect
  camUp: vec4f,     // w: windOn
  sunDir: vec4f,    // w: cacheOn
  par: vec4f,       // grassR0, grassR1, phi0, phi1
  grid: vec4f,      // cellSize, gridN, originX, originZ
  misc: vec4f,      // bladesPerCell, repeatW, -, -
}
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var cacheTex: texture_2d<f32>;
@group(0) @binding(2) var cacheSamp: sampler;

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
// v=角度 の連続写像だけだと、角度変化が緩い帯域で v がほぼ止まり、
// テクスチャがレイ方向に引き伸ばされる。v を角度帯 (スライス) に量子化し、
// 帯内はワールド距離基準で v を動かしてキャプチャ時の縮尺 (dv/ds = sinφ/H) を保ち、
// 帯間は実際の角度で mix する。
// 帯内の反復は、三角波ミラーだと折り返しごとに草が上下反転して見えるため、
// のこぎり波を半周期ずらした2位相のクロスフェード (継ぎ目で重み0) で行う。
const NSLICE = 12.0;
const SLICE_HW = 0.5 / NSLICE;
fn sliceSample(uc: f32, k: f32, r: f32, gx: vec2f, gy: vec2f) -> vec4f {
  let vk = (k + 0.5) / NSLICE;
  let phik = u.par.z + (u.par.w - u.par.z) * vk;
  // キャプチャでは遠ざかる方向 (+s) が画像の上 (v 減少) なので、r の増加で v を減らす
  let m = r * sin(phik) / (${H_CAP}.0 * SLICE_HW * 2.0);
  let fA = fract(m);
  let fB = fract(m + 0.5);
  let wA = 1.0 - abs(2.0 * fA - 1.0);
  let sA = textureSampleGrad(cacheTex, cacheSamp, vec2f(uc, vk + SLICE_HW * (1.0 - 2.0 * fA)), gx, gy);
  let sB = textureSampleGrad(cacheTex, cacheSamp, vec2f(uc + 0.37, vk + SLICE_HW * (1.0 - 2.0 * fB)), gx, gy);
  return mix(sB, sA, wA);
}
fn cacheSample(uc: f32, vc: f32, r: f32, gx: vec2f, gy: vec2f) -> vec4f {
  let fk = clamp(vc * NSLICE - 0.5, 0.0, NSLICE - 1.0);
  let k0 = floor(fk);
  let wk = fk - k0;
  return mix(sliceSample(uc, k0, r, gx, gy),
             sliceSample(uc, min(k0 + 1.0, NSLICE - 1.0), r, gx, gy), wk);
}

@fragment fn fsTerrain(in: TOut) -> @location(0) vec4f {
  let wp = in.wp;
  let N = terrainN(wp.xz);
  let toF = wp - u.camPos.xyz;
  let dist = length(toF);
  let V = toF / dist;
  let groundLit = shadeGround(groundAlbedo(wp.xz*0.7), N, u.sunDir.xyz);
  let sinG = clamp(abs(dot(V, N)), 0.0, 1.0);
  let phi = asin(sinG);
  let vc = clamp((phi - u.par.z) / (u.par.w - u.par.z), 0.0, 1.0);
  let r = distance(wp.xz, u.camPos.xz);
  // u はワールド固定の x/z 2系統を、フラグメントごとの視線水平方向の重みでブレンドする
  // (バイプラナー)。視線方向basisの u だとヨー回転で貼り付けが滑るのに対し、
  // 各フラグメントへのレイ方向は回転不変なので、回転中もブレンド込みで完全に静止する。
  let ux = wp.x / u.misc.y;
  let uz = wp.z / u.misc.y;
  // ミップ選択用の勾配は、のこぎり波の巻き戻り不連続を含まない
  // 「ワールド距離基準の v」の代理値から取る
  let vlin = r * sin(phi) / ${H_CAP}.0;
  let proxyX = vec2f(ux, vlin);
  let proxyZ = vec2f(uz, vlin);
  let pxx = dpdx(proxyX);
  let pxy = dpdy(proxyX);
  let pzx = dpdx(proxyZ);
  let pzy = dpdy(proxyZ);
  let vx4 = V.x*V.x*V.x*V.x;
  let vz4 = V.z*V.z*V.z*V.z;
  let wx = (vz4 + 5e-9) / (vx4 + vz4 + 1e-8);
  let s = cacheSample(ux, vc, r, pxx, pxy) * wx + cacheSample(uz, vc, r, pzx, pzy) * (1.0 - wx);
  // u が視線依存座標のため、テクスチャは奥行き方向の変化を角度(v)しか持たず、
  // 急角度帯で同じ内容がレイ方向に伸びる。ワールドアンカーの coverage 変調で崩す。
  // グレージング角では実際の草も coverage が飽和するので変調しない。
  let dn = 0.5 + 0.5*sin(wp.x*0.9 + sin(wp.z*0.7)*1.3)*sin(wp.z*0.8 + sin(wp.x*0.6)*1.4);
  let cov = s.a * (1.0 - 0.45*dn*smoothstep(0.35, 0.9, sinG)) * u.sunDir.w;
  let attr = s.rgb / max(s.a, 0.002);
  let alb = grassAlbedo(attr.r, attr.b) * patchTint(wp.xz);
  let grassLit = shadeGrass(alb, N, V, u.sunDir.xyz, attr.r, attr.g);
  var c = mix(groundLit, grassLit, cov);
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
  var bp = bladeParams(s1, s2);
  bp.height *= fade;
  bp.halfW *= fade;
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

// --- atlas overlay ---
struct OOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vsOverlay(@builtin(vertex_index) vi: u32) -> OOut {
  let corner = vec2f(f32(vi % 2u), f32((vi / 2u) % 2u)); // 0..1
  let x = mix(0.30, 0.98, corner.x);
  let y = mix(-0.95, -0.29, corner.y);
  var o: OOut;
  o.pos = vec4f(x, y, 0.0, 1.0);
  o.uv = vec2f(corner.x, 1.0 - corner.y);
  return o;
}
@fragment fn fsOverlay(in: OOut) -> @location(0) vec4f {
  let s = textureSampleLevel(cacheTex, cacheSamp, in.uv, 0.0);
  let attr = s.rgb / max(s.a, 0.002);
  let alb = grassAlbedo(attr.r, attr.b) * (0.7 + 0.9*attr.g);
  let c = mix(vec3f(0.16, 0.13, 0.08), alb*2.2, s.a);
  return vec4f(pow(c, vec3f(1.0/2.2)), 1.0);
}
`;

const BAKE_WGSL = COMMON + /* wgsl */`
struct BU { proj: mat4x4f }
@group(0) @binding(0) var<uniform> bu: BU;

struct BOut { @builtin(position) pos: vec4f, @location(0) tv: vec2f }
@vertex fn vsBlade(@location(0) vt: vec2f, @location(1) ibase: vec4f, @location(2) inrm: vec4f) -> BOut {
  let hash = ibase.w;
  let bp = bladeParams(hash, h11(hash*77.7 + 0.31));
  let p = bladeVertex(ibase.xyz, inrm.xyz, vt.x, vt.y, bp, vec3f(0.0));
  var o: BOut;
  o.pos = bu.proj * vec4f(p, 1.0);
  o.tv = vec2f(vt.x, bp.varh);
  return o;
}
@fragment fn fsBlade(in: BOut) -> @location(0) vec4f {
  return vec4f(in.tv.x, grassAO(in.tv.x), in.tv.y, 1.0);
}

@vertex fn vsGround(@location(0) pos: vec3f) -> @builtin(position) vec4f {
  return bu.proj * vec4f(pos, 1.0);
}
@fragment fn fsGround() -> @location(0) vec4f {
  return vec4f(0.0);
}
`;

const POST_WGSL = /* wgsl */`
@group(0) @binding(0) var src: texture_2d<f32>;
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32(i32(vi & 1u) * 4 - 1);
  let y = f32(i32(vi >> 1u) * 4 - 1);
  return vec4f(x, y, 0.0, 1.0);
}
@fragment fn fsDown(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let base = vec2u(fc.xy) * ${SS}u;
  var acc = vec4f(0.0);
  for (var j = 0u; j < ${SS}u; j++) {
    for (var i = 0u; i < ${SS}u; i++) {
      acc += textureLoad(src, base + vec2u(i, j), 0);
    }
  }
  return acc / ${SS * SS}.0;
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

// ---------- bake curve ----------
// 接線角 φ が y に線形で、上に行くほど減る凸面 (丘の稜線状): 下端が急角度、
// 上端がグレージング角。実行時は画面上方ほど遠方=浅い角度なので、この向きだと
// テクスチャ内の草の上下と葉同士の遮蔽方向が画面と一致する。
// z(φ) = (H/Δφ)·ln(sin φ / sin φ1)。グレージング行に映る草は長い区間の積分だが、
// その区間はカーブ上端の漸近部分に含まれるので平坦助走は不要。
const S_TOTAL = H_CAP / DPHI * Math.log(Math.tan(PHI1 / 2) / Math.tan(PHI0 / 2));
const S_EXT_BOT = 0.6;
const S_EXT_TOP = 1.0;

function curveAt(s) {
  if (s <= 0) return { phi: PHI1, y: s * Math.sin(PHI1), z: -s * Math.cos(PHI1) };
  const phi = 2 * Math.atan(Math.tan(PHI1 / 2) * Math.exp(-s * DPHI / H_CAP));
  if (phi <= PHI0) {
    const zS = H_CAP / DPHI * Math.log(Math.sin(PHI0) / Math.sin(PHI1));
    const e = s - S_TOTAL;
    return { phi: PHI0, y: H_CAP + e * Math.sin(PHI0), z: zS - e * Math.cos(PHI0) };
  }
  return { phi, y: H_CAP * (PHI1 - phi) / DPHI, z: H_CAP / DPHI * Math.log(Math.sin(phi) / Math.sin(PHI1)) };
}

// ---------- main ----------

async function main() {
  if (!navigator.gpu) throw new Error('WebGPU unsupported');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('no GPU adapter');
  const device = await adapter.requestDevice();
  const ctx = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device, format, alphaMode: 'opaque' });

  const bladeMesh = device.createBuffer({ size: 9 * 2 * 4, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
  new Float32Array(bladeMesh.getMappedRange()).set([
    0, -1, 0, 1, 0.25, -1, 0.25, 1, 0.5, -1, 0.5, 1, 0.75, -1, 0.75, 1, 1, 0,
  ]);
  bladeMesh.unmap();
  const bladeIdx = device.createBuffer({ size: 44, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
  new Uint16Array(bladeIdx.getMappedRange()).set([0, 1, 2, 2, 1, 3, 2, 3, 4, 4, 3, 5, 4, 5, 6, 6, 5, 7, 6, 7, 8]);
  bladeIdx.unmap();
  const bladeVertLayout = { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }] };

  // --- bake ---
  const bakeT0 = performance.now();
  const cacheTex = device.createTexture({
    size: [CACHE_W, CACHE_H], format: 'rgba8unorm',
    mipLevelCount: Math.log2(CACHE_W) + 1,
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
  });
  {
    const ssW = CACHE_W * SS, ssH = CACHE_H * SS;
    const ssTex = device.createTexture({
      size: [ssW, ssH], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    const ssDepth = device.createTexture({ size: [ssW, ssH], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });

    const arc = S_TOTAL + S_EXT_BOT + S_EXT_TOP;
    const nBlades = Math.floor(BAKE_DENSITY * W_CAP * arc);
    const inst = new Float32Array(nBlades * 3 * 8);
    let o = 0;
    for (let i = 0; i < nBlades; i++) {
      const { phi, y, z } = curveAt(-S_EXT_BOT + Math.random() * arc);
      const x0 = Math.random() * W_CAP;
      const hash = Math.random();
      const ny = Math.cos(phi), nz = Math.sin(phi);
      for (const dx of [-W_CAP, 0, W_CAP]) {
        inst[o++] = x0 + dx; inst[o++] = y; inst[o++] = z; inst[o++] = hash;
        inst[o++] = 0; inst[o++] = ny; inst[o++] = nz; inst[o++] = 0;
      }
    }
    const instBuf = device.createBuffer({ size: inst.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(instBuf.getMappedRange()).set(inst);
    instBuf.unmap();

    const ROWS = 1400;
    const ground = new Float32Array((ROWS + 1) * 2 * 3);
    for (let r = 0; r <= ROWS; r++) {
      const { y, z } = curveAt(-S_EXT_BOT + (arc * r) / ROWS);
      ground.set([-1, y, z, W_CAP + 1, y, z], r * 6);
    }
    const groundIdx = new Uint32Array(ROWS * 6);
    for (let r = 0; r < ROWS; r++) {
      const a = r * 2;
      groundIdx.set([a, a + 1, a + 2, a + 2, a + 1, a + 3], r * 6);
    }
    const groundBuf = device.createBuffer({ size: ground.byteLength, usage: GPUBufferUsage.VERTEX, mappedAtCreation: true });
    new Float32Array(groundBuf.getMappedRange()).set(ground);
    groundBuf.unmap();
    const groundIdxBuf = device.createBuffer({ size: groundIdx.byteLength, usage: GPUBufferUsage.INDEX, mappedAtCreation: true });
    new Uint32Array(groundIdxBuf.getMappedRange()).set(groundIdx);
    groundIdxBuf.unmap();

    const zN = 1;
    const zF = curveAt(S_TOTAL + S_EXT_TOP).z - 1;
    const proj = new Float32Array([
      2 / W_CAP, 0, 0, 0,
      0, 2 / H_CAP, 0, 0,
      0, 0, -1 / (zN - zF), 0,
      -1, -1, zN / (zN - zF), 1,
    ]);
    const bakeUBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(bakeUBuf, 0, proj);

    const bakeMod = device.createShaderModule({ code: BAKE_WGSL });
    const bakeTargets = [{ format: 'rgba8unorm' }];
    const bakeDepth = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };
    const bladePipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: bakeMod, entryPoint: 'vsBlade',
        buffers: [
          bladeVertLayout,
          {
            arrayStride: 32, stepMode: 'instance',
            attributes: [
              { shaderLocation: 1, offset: 0, format: 'float32x4' },
              { shaderLocation: 2, offset: 16, format: 'float32x4' },
            ],
          },
        ],
      },
      fragment: { module: bakeMod, entryPoint: 'fsBlade', targets: bakeTargets },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: bakeDepth,
    });
    const groundPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: {
        module: bakeMod, entryPoint: 'vsGround',
        buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }],
      },
      fragment: { module: bakeMod, entryPoint: 'fsGround', targets: bakeTargets },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: bakeDepth,
    });
    const bladeBind = device.createBindGroup({
      layout: bladePipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: bakeUBuf } }],
    });
    const groundBind = device.createBindGroup({
      layout: groundPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: bakeUBuf } }],
    });

    const postMod = device.createShaderModule({ code: POST_WGSL });
    const downPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: postMod, entryPoint: 'vsFull' },
      fragment: { module: postMod, entryPoint: 'fsDown', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });
    const mipPipe = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: postMod, entryPoint: 'vsFull' },
      fragment: { module: postMod, entryPoint: 'fsMip', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    });

    const enc = device.createCommandEncoder();
    {
      const pass = enc.beginRenderPass({
        colorAttachments: [{ view: ssTex.createView(), loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store' }],
        depthStencilAttachment: { view: ssDepth.createView(), depthLoadOp: 'clear', depthClearValue: 1, depthStoreOp: 'discard' },
      });
      pass.setPipeline(groundPipe);
      pass.setBindGroup(0, groundBind);
      pass.setVertexBuffer(0, groundBuf);
      pass.setIndexBuffer(groundIdxBuf, 'uint32');
      pass.drawIndexed(groundIdx.length);
      pass.setPipeline(bladePipe);
      pass.setBindGroup(0, bladeBind);
      pass.setVertexBuffer(0, bladeMesh);
      pass.setVertexBuffer(1, instBuf);
      pass.setIndexBuffer(bladeIdx, 'uint16');
      pass.drawIndexed(21, nBlades * 3);
      pass.end();
    }
    {
      const bind = device.createBindGroup({
        layout: downPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: ssTex.createView() }],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: cacheTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }),
          loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store',
        }],
      });
      pass.setPipeline(downPipe);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    }
    for (let lv = 1; lv < cacheTex.mipLevelCount; lv++) {
      const bind = device.createBindGroup({
        layout: mipPipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: cacheTex.createView({ baseMipLevel: lv - 1, mipLevelCount: 1 }) }],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: cacheTex.createView({ baseMipLevel: lv, mipLevelCount: 1 }),
          loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store',
        }],
      });
      pass.setPipeline(mipPipe);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    ssTex.destroy();
    ssDepth.destroy();
    instBuf.destroy();
  }
  const bakeMs = performance.now() - bakeT0;

  // --- runtime ---
  const runtimeMod = device.createShaderModule({ code: RUNTIME_WGSL });
  const MSAA = 4;
  const uBuf = device.createBuffer({ size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const cacheSamp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'clamp-to-edge', maxAnisotropy: 16,
  });
  const bindLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const bind = device.createBindGroup({
    layout: bindLayout,
    entries: [
      { binding: 0, resource: { buffer: uBuf } },
      { binding: 1, resource: cacheTex.createView() },
      { binding: 2, resource: cacheSamp },
    ],
  });
  const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [bindLayout] });
  const targets = [{ format }];
  const depthOn = { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' };

  const skyPipe = device.createRenderPipeline({
    layout: pipeLayout,
    vertex: { module: runtimeMod, entryPoint: 'vsSky' },
    fragment: { module: runtimeMod, entryPoint: 'fsSky', targets },
    primitive: { topology: 'triangle-list' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    multisample: { count: MSAA },
  });
  const terrainPipe = device.createRenderPipeline({
    layout: pipeLayout,
    vertex: { module: runtimeMod, entryPoint: 'vsTerrain' },
    fragment: { module: runtimeMod, entryPoint: 'fsTerrain', targets },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthOn,
    multisample: { count: MSAA },
  });
  const grassPipe = device.createRenderPipeline({
    layout: pipeLayout,
    vertex: { module: runtimeMod, entryPoint: 'vsGrass', buffers: [bladeVertLayout] },
    fragment: { module: runtimeMod, entryPoint: 'fsGrass', targets },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthOn,
    multisample: { count: MSAA },
  });
  const overlayPipe = device.createRenderPipeline({
    layout: pipeLayout,
    vertex: { module: runtimeMod, entryPoint: 'vsOverlay' },
    fragment: { module: runtimeMod, entryPoint: 'fsOverlay', targets },
    primitive: { topology: 'triangle-strip' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    multisample: { count: MSAA },
  });

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
    geomOn: true, cacheOn: true, windOn: true, atlasOn: false, paused: false,
    bpc: 32, r1: 24, sunAz: 2.4, sunEl: 0.66,
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
    if (k === 'c') state.cacheOn = !state.cacheOn;
    if (k === 't') state.atlasOn = !state.atlasOn;
    if (k === 'v') state.windOn = !state.windOn;
    if (k === 'p') state.paused = !state.paused;
    if (k === '1') state.sunAz -= 0.15;
    if (k === '2') state.sunAz += 0.15;
    if (k === '3') state.bpc = Math.max(4, state.bpc / 2);
    if (k === '4') state.bpc = Math.min(64, state.bpc * 2);
    if (k === '5') state.r1 = Math.max(6, state.r1 - 3);
    if (k === '6') state.r1 = Math.min(24, state.r1 + 3);
  });
  window.addEventListener('keyup', e => state.keys.delete(e.key.toLowerCase()));

  window.demo = {
    state,
    setCam(x, y, z, yaw, pitch) {
      state.pos = [x, y, z]; state.yaw = yaw; state.pitch = pitch;
    },
    terrainH: terrainHJS,
  };

  // --- frame loop ---
  const uData = new Float32Array(48);
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
    const fwd2 = [sy, -cy], right2 = [cy, sy];
    let mx = 0, mz = 0, my = 0;
    if (state.keys.has('w')) { mx += fwd2[0]; mz += fwd2[1]; }
    if (state.keys.has('s')) { mx -= fwd2[0]; mz -= fwd2[1]; }
    if (state.keys.has('d')) { mx += right2[0]; mz += right2[1]; }
    if (state.keys.has('a')) { mx -= right2[0]; mz -= right2[1]; }
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
    uData.set([sun[0], sun[1], sun[2], state.cacheOn ? 1 : 0], 32);
    uData.set([state.r1 * 0.7, state.r1, PHI0, PHI1], 36);
    uData.set([CELL, GRID_N, ox, oz], 40);
    uData.set([state.bpc, W_CAP, 0, 0], 44);
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
    pass.setBindGroup(0, bind);
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
    if (state.atlasOn) {
      pass.setPipeline(overlayPipe);
      pass.draw(4);
    }
    pass.end();
    device.queue.submit([enc.finish()]);

    const blades = state.geomOn ? GRID_N * GRID_N * state.bpc : 0;
    hud.textContent =
      `fps ${state.fps.toFixed(0)}  bake ${bakeMs.toFixed(0)}ms  blades ${(blades / 1000).toFixed(0)}k\n` +
      `geom[G] ${state.geomOn ? 'on' : 'off'}  cache[C] ${state.cacheOn ? 'on' : 'off'}  ` +
      `wind[V] ${state.windOn ? 'on' : 'off'}  atlas[T] ${state.atlasOn ? 'on' : 'off'}\n` +
      `radius[5/6] ${state.r1}m  density[3/4] ${state.bpc}/cell  sun[1/2] ${(state.sunAz * 180 / Math.PI).toFixed(0)}°\n` +
      `drag:look  WASD:move  R/F:up/down  Shift:fast  P:pause`;

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main().catch(e => {
  console.error(e);
  const el = document.getElementById('err');
  el.style.display = 'grid';
  el.textContent = String(e);
});
