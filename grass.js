// 遠景草の別方式実験 (方向性ぼかし版):
// 草を一様色の鉛直な棒とみなすと、遠景で見えるのは密度テクスチャを視線方位に
// 沿って平均した量になる。厳密な線積分 (プレフィックス差分) は補間誤差で不安定
// だったため、固定長の方向性ぼかしを 16 方位ぶん事前計算したテクスチャで代用する。
// グレージング投影では視線方位に沿った地面のスジが画面上でほぼ鉛直に立つので、
// 遠景では模様の方向性が合っていれば草に見える、という割り切り。

// 実験用ノブ: ?ndir=16&dtex=512&dspan=5.12 のように URL パラメータで変更できる
// (dtex は 2 の冪)。詳細格子は常に2枚 (半量子回転差) 重ねる
const q = new URLSearchParams(location.search);
const NDIR = parseInt(q.get('ndir') || '12', 10);   // 180° を等分。ぼかしは対称なので逆向きの区別は不要
const DETAIL_TEX = parseInt(q.get('dtex') || '256', 10);
const DETAIL_SPAN = parseFloat(q.get('dspan') || '5');
const TEX = 4096;
const REG_MIN = -512, REG_SPAN = 1024;
// 方向性ぼかしは詳細タイルだけが持つ。マクロ密度 (0.25m/texel) を
// 方向別に持つと 32 方向でメモリが数百 MB 級になる割に、パッチスケールでは
// 方向の効果がほぼ見えないため
const SLAB_H = 0.35;
const TER_EXTENT = 2400, TER_GRID = 512;

// 近景ジオメトリ草 (回転楕円体インポスター)。チャンク 4m 四方 = 0.5m セル 8×8、
// 1 チャンクのインスタンス添字は k (セル内何本目) 優先で、遠いチャンクほど先頭の
// 一部だけ描く (prefix 描画)。チャンクの識別は firstInstance に乗せる
const G_CHUNK = 4, G_CELLS = 8;
const G_CELL = G_CHUNK / G_CELLS;
const G_MAX_BPC = 32;
const G_MAX_INST = G_CELLS * G_CELLS * G_MAX_BPC;
const G_MAX_CHUNKS = 4096;
// 1 本ごとの σ フェードにかける生存順位の幅 (順位間隔の何倍か)
const G_BAND = 2;

// 楕円体中心の根元からの高さ (半長軸比)。1 未満なら下部が地中に沈み、地面で切れる
const G_CF = parseFloat(q.get('gcf') || '0.75');

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

// しきい値処理は 0/1 のベタ塗り領域を作るため使わない。μ±2σ を [0,1] に
// 線形で広げ (飽和は裾の数%のみ)、全域に連続な濃淡を残す
function normalizeField(a) {
  let mu = 0;
  for (let i = 0; i < a.length; i++) mu += a[i];
  mu /= a.length;
  let s2 = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - mu; s2 += d * d; }
  const sd = Math.sqrt(s2 / a.length) || 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const r = Math.min(1, Math.max(0, 0.5 + (a[i] - mu) / (4 * sd)));
    a[i] = r;
    sum += r;
  }
  return sum / a.length;
}

function genDensity() {
  const a = new Float32Array(TEX * TEX);
  const texel = REG_SPAN / TEX;
  for (let z = 0; z < TEX; z++) {
    const wz = REG_MIN + (z + 0.5) * texel;
    for (let x = 0; x < TEX; x++) {
      const wx = REG_MIN + (x + 0.5) * texel;
      // 最小オクターブの波長はテクセルのナイキスト (0.5m) より十分上に取る
      a[z * TEX + x] = 0.35 * vn(wx / 9, wz / 9)
        + 0.28 * vn(wx / 3.1 + 31.7, wz / 3.1 + 11.1)
        + 0.22 * vn(wx / 1.9 + 71.3, wz / 1.9 + 47.9)
        + 0.15 * vn(wx / 0.9 + 13.9, wz / 0.9 + 57.1);
    }
  }
  return { rho: a, mean: normalizeField(a) };
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

// 葉幅スケール (最小 ~4cm) のタイル詳細密度。ノイズ格子をタイル周期で
// ラップさせてシームレスにする。格子周期は DETAIL_SPAN の整数分割に丸めて
// 任意の dspan でも周期性を保つ
function genDetail() {
  const a = new Float32Array(DETAIL_TEX * DETAIL_TEX);
  const texel = DETAIL_SPAN / DETAIL_TEX;
  const p1 = Math.round(DETAIL_SPAN / 0.04);
  const p2 = Math.round(DETAIL_SPAN / 0.08);
  const p3 = Math.round(DETAIL_SPAN / 0.32);
  for (let z = 0; z < DETAIL_TEX; z++) {
    const wz = (z + 0.5) * texel;
    for (let x = 0; x < DETAIL_TEX; x++) {
      const wx = (x + 0.5) * texel;
      a[z * DETAIL_TEX + x] = 0.45 * vnT(wx * p1 / DETAIL_SPAN, wz * p1 / DETAIL_SPAN, p1, 137)
        + 0.30 * vnT(wx * p2 / DETAIL_SPAN, wz * p2 / DETAIL_SPAN, p2, 71)
        + 0.25 * vnT(wx * p3 / DETAIL_SPAN, wz * p3 / DETAIL_SPAN, p3, 17);
    }
  }
  return { det: a, mean: normalizeField(a) };
}

// ---------- WGSL ----------

const OV_COLS = NDIR > 16 ? 8 : 4;
const OV_ROWS = Math.ceil(NDIR / OV_COLS);

const COMMON = /* wgsl */`
const PI = 3.141592653589793;
fn h11(n: f32) -> f32 { return fract(sin(n) * 43758.5453123); }
fn h21(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123); }
fn hashU(x: u32) -> u32 {
  var h = x;
  h ^= h >> 16u; h *= 0x7feb352du;
  h ^= h >> 15u; h *= 0x846ca68bu;
  h ^= h >> 16u;
  return h;
}
fn hash3f(a: i32, b: i32, c: i32) -> f32 {
  let h = hashU((bitcast<u32>(a) * 0x9E3779B1u) ^ hashU((bitcast<u32>(b) * 0x85EBCA77u) ^ hashU(bitcast<u32>(c))));
  return f32(h) / 4294967296.0;
}

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

// 地形メッシュと同じ三角形分割で補間した高さ。解析的 terrainH はメッシュ面から
// 10cm 前後ずれるので、草の根元はこちらに置く
fn meshH(p: vec2f) -> f32 {
  let g = (p / ${TER_EXTENT}.0 + 0.5) * ${TER_GRID}.0;
  let g0 = floor(g);
  let f = g - g0;
  let s = ${TER_EXTENT / TER_GRID};
  let p0 = (g0 / ${TER_GRID}.0 - 0.5) * ${TER_EXTENT}.0;
  let h00 = terrainH(p0);
  let h10 = terrainH(p0 + vec2f(s, 0.0));
  let h01 = terrainH(p0 + vec2f(0.0, s));
  let h11 = terrainH(p0 + vec2f(s, s));
  if (f.x + f.y < 1.0) {
    return h00 + (h10 - h00)*f.x + (h01 - h00)*f.y;
  }
  return h11 + (h01 - h11)*(1.0 - f.x) + (h10 - h11)*(1.0 - f.y);
}

const ROOT_COL  = vec3f(0.09, 0.19, 0.04);
const TIP_COL   = vec3f(0.42, 0.60, 0.18);
const DRY_COL   = vec3f(1.25, 1.10, 0.55);
const SUN_COL   = vec3f(1.20, 1.08, 0.88);
const SKY_AMB   = vec3f(0.30, 0.42, 0.58);
const TRANS_COL = vec3f(0.45, 0.60, 0.16);

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
  par: vec4f,       // kOpacity, slabH, rhoMean, detailMean
  misc: vec4f,      // flatGround, 偽草の足元線分長 L の下限 (真上から見た葉の見かけの厚み), 筋を溶かす半径, -
  geo: vec4f,       // 密度フェード開始距離, 終了距離, bladesPerCell, sigma (葉の光学的厚さ)
  geo2: vec4f,      // height, width, 株の密度ゲイン (色の明暗), dither
}
fn rhoUV(p: vec2f) -> vec2f {
  return (p - vec2f(${REG_MIN}.0)) / ${REG_SPAN}.0;
}
`;

const SCENE_WGSL = COMMON + /* wgsl */`
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var rhoTex: texture_2d<f32>;
@group(0) @binding(3) var detailArr: texture_2d_array<f32>;
@group(0) @binding(4) var sampR: sampler;
@group(0) @binding(5) var<storage, read> chunks: array<vec4f>;  // ox, oz, cx, cz

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
// 1格子ぶんの方向性詳細密度。格子を β 回転して貼る場合、テクスチャ空間で
// 参照すべきぼかし方位は θ_view − β (筋は貼り付けの回転を経て世界では視線方位に揃う)
fn latticeDetail(p: vec2f, windW: vec2f, thetaView: f32, beta: f32) -> f32 {
  var tm = thetaView - beta;
  tm = tm - floor(tm / PI) * PI;
  var i0 = floor(tm / (PI / ${NDIR}.0));
  let fw = tm / (PI / ${NDIR}.0) - i0;
  if (i0 > ${NDIR - 1}.5) { i0 = ${NDIR - 1}.0; }
  let cb = cos(beta);
  let sb = sin(beta);
  let lp = vec2f(cb*p.x + sb*p.y, -sb*p.x + cb*p.y);
  let lw = vec2f(cb*windW.x + sb*windW.y, -sb*windW.x + cb*windW.y);
  // 参照点を p − w にすると模様は +w 方向へ動く (ジオメトリ草の先端と同じ向き)
  let duv = (lp - lw) / ${DETAIL_SPAN};
  // レイヤー i の rg には方位 (i, i+1) がペアで焼いてあるので、補間に要る隣接2方位が 1 fetch で揃う
  let d = textureSample(detailArr, sampR, duv, i32(i0)).rg;
  return mix(d.x, d.y, fw);
}

// 地面+遠景草オーバーレイ込みの表面色 (フォグ・トーンマップ前)
fn surfaceColor(wp: vec3f, V: vec3f, dist: f32) -> vec3f {
  let N = terrainN(wp.xz);
  let uv = rhoUV(wp.xz);
  let edge = max(abs(wp.x), abs(wp.z));
  let regFade = 1.0 - smoothstep(${REG_SPAN / 2 - 40}.0, ${REG_SPAN / 2}.0, edge);
  let ndl = max(dot(N, u.sunDir.xyz), 0.0);
  let rho = mix(u.par.z, textureSample(rhoTex, samp, uv).r, regFade);
  // groundAlbedo の手続きノイズはミップを持たないため、遠方でモアレになる前に均す
  let dirt = mix(groundAlbedo(wp.xz*0.7), vec3f(0.20, 0.16, 0.10), min(dist*0.01, 1.0));
  var gAlb = mix(dirt, ROOT_COL*1.4, clamp(rho*0.85 + 0.05, 0.0, 1.0)) * patchTint(wp.xz);
  // 単色地面モード: 方向性レイヤーの効果と地面の色変化を切り分ける検証用
  if (u.misc.x > 0.5) { gAlb = vec3f(0.17, 0.14, 0.11); }
  var c = gAlb * (SUN_COL*ndl + SKY_AMB*0.9);
  if (u.sunDir.w > 0.5) {
    // 視線方位に沿ってぼかした密度を引く。方位量子化は隣接2方位の lerp
    // (ぼかしは対称なので 180° 周期、符号処理は不要)
    var rh = V.xz;
    let lh = length(rh);
    rh = select(rh / lh, vec2f(1.0, 0.0), lh < 1e-5);
    let thetaView = atan2(rh.y, rh.x);
    var windW = vec2f(0.0);
    if (u.camUp.w > 0.5) {
      // 風: 参照位置のオフセット = 筋全体の平行移動。根元固定のせん断ではないが
      // 遠景では株の揺らぎとして通る。位相場は近景ブレードの風と同じ式で整合させる
      let time = u.camPos.w;
      let wamp = 0.10*sin(time*1.9 + wp.x*0.35 + wp.z*0.22) + 0.05*sin(time*3.7 + wp.z*0.53 + wp.x*0.31);
      windW = vec2f(0.86, 0.5) * (wamp * 0.6);
    }
    // 2格子を半量子 (π/2NDIR) 回転差で重ねる: 回転角が格子と非通約なので合成場は
    // 非周期になり、方向量子化の誤差も格子間で非相関化される。
    // 2枚の和 (÷2) を表現したい場そのものとみなし、分散の √2 復元はしない
    // (復元すると最大値が範囲を超え、濃部にベタ塗りが出る)
    let dsum = (latticeDetail(wp.xz, windW, thetaView, 0.0)
              + latticeDetail(wp.xz, windW, thetaView, ${Math.PI / (2 * NDIR)})) * 0.5;
    let detN = dsum / max(u.par.w, 1e-3);
    // 正規化で潰れた振幅を偏差ゲインで戻す (0 クランプは max で滑らかに回避)
    var detB = max(1.0 + (detN - 1.0) * 2.4, 0.05);
    let sinG = clamp(abs(dot(V, N)), 0.02, 1.0);
    // 筋はカメラ足元を中心に放射状に並ぶので、足元からの水平距離が筋の長さ (~0.8m) と
    // 同程度の範囲では 1 本の筋の中で方位が曲がり、放射模様として見える。そこだけ方向性を
    // 平均 (detB=1) に溶かす。角度で判定すると高高度で真下の広い範囲のディテールが消える
    let rHoriz = distance(wp.xz, u.camPos.xz);
    detB = mix(detB, 1.0, 1.0 - smoothstep(u.misc.z * 0.3, u.misc.z, rHoriz));
    // マクロは無方向の連続密度、方向性は詳細レイヤーが担う
    var rd = rho * (0.25 + 0.75 * detB);
    // 不透明度: 密度 × グレージングでの見かけ光路長 (足元線分長は固定上限でクランプ)
    // 下限は真上から見た葉の見かけの厚み。0 に近いと見下ろしで地面色だけになり、
    // 上に重ねるジオメトリ草 (glit 色) が浮く
    let L = clamp(u.par.y * sqrt(1.0 - sinG*sinG) / sinG, u.misc.y, 12.0);
    let tau = u.par.x * rd * L;
    let alpha = 1.0 - exp(-tau);
    // 高密度側でも飽和しない線形カーブにして、密草地帯の中の濃淡を残す
    let shade = 1.35 - 0.52 * min(rd, 2.2);
    var galb = mix(ROOT_COL, TIP_COL, 0.6) * shade;
    if (u.misc.x < 0.5) { galb *= patchTint(wp.xz); }
    var glit = galb * (SUN_COL*ndl*0.9 + SKY_AMB*0.75);
    glit += TRANS_COL * pow(max(dot(V, u.sunDir.xyz), 0.0), 6.0) * 0.25;
    c = mix(c, glit, alpha);
  }
  return c;
}
@fragment fn fsTerrain(in: TOut) -> @location(0) vec4f {
  let toF = in.wp - u.camPos.xyz;
  let dist = length(toF);
  let V = toF / dist;
  var c = surfaceColor(in.wp, V, dist);
  c = applyFog(c, dist, dot(V, u.sunDir.xyz));
  return vec4f(tonemap(c), 1.0);
}

// --- 近景ジオメトリ草: 回転楕円体インポスター ---
// 偽草の「一様色の鉛直な棒」モデルに合わせ、1本を鉛直軸まわりに対称な回転楕円体で描く。
// 立体なのでビルボードでも回り込みで形が変わらず、レイの通過長から縁が柔らかく出る
struct GOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,
  @location(1) center: vec3f,
  @location(2) axis: vec3f,
  @location(3) prm: vec4f,   // 半長軸 a, 半径 r, sigma, -
  @location(4) col: vec3f,
}
fn densAt(d: f32) -> f32 { return 1.0 - smoothstep(u.geo.x, u.geo.y, d); }

@vertex fn vsGrass(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  let slot = ii / ${G_MAX_INST}u;
  let li = ii % ${G_MAX_INST}u;
  let ch = chunks[slot];
  let cell = li % ${G_CELLS * G_CELLS}u;
  let k = li / ${G_CELLS * G_CELLS}u;
  let ci = i32(cell % ${G_CELLS}u);
  let cj = i32(cell / ${G_CELLS}u);
  // 乱数はワールドセル座標から: カメラ追従で描画範囲が動いても同じ場所には同じ草
  let gx = i32(ch.z) * ${G_CELLS} + ci;
  let gz = i32(ch.w) * ${G_CELLS} + cj;
  let ki = i32(k);
  let h0 = hash3f(gx, gz, ki);
  let h1 = hash3f(gx, gz, ki + 1000);
  let h2 = hash3f(gx, gz, ki + 2000);
  let h3 = hash3f(gx, gz, ki + 3000);
  let hc = hash3f(gx, gz, -1);
  let bxz = vec2f(ch.x + (f32(ci) + h0) * ${G_CELL}, ch.y + (f32(cj) + h1) * ${G_CELL});
  let base = vec3f(bxz.x, meshH(bxz), bxz.y);
  // CPU のチャンク判定は水平距離 (上界)。ここでは高低差込みの 3D 距離で減衰する
  let d = distance(base, u.camPos.xyz);
  let bpc = u.geo.z;
  // 生存順位: セル共通のずらし hc で、同じ k の草が全セル同時に消えないようにする。
  // 順位は [0, 1 − band/bpc] に縮め、密度 1 の近景ではフェード幅の分も含めて全数が不透明になるようにする
  let rank = (f32(k) + hc) / bpc * max(1.0 - ${G_BAND}.0 / bpc, 0.5);
  let rho = textureSampleLevel(rhoTex, samp, rhoUV(bxz), 0.0).r;
  // 地面色が土に寄る低密度域では 0 本にする。上限側は偽草の不透明度 (ρ に比例) と
  // 減り方を揃えるため低めに取る (高いと中密度帯でジオメトリだけ先に疎になる)
  let keep = smoothstep(0.1, 0.45, rho);
  // 距離フェードは大きさでなく光学的厚さ σ を落として透明化する
  let fade = clamp((densAt(d) * keep - rank) * bpc / ${G_BAND}.0, 0.0, 1.0);
  let H = u.geo2.x * (0.6 + 0.8*h2);
  let r = u.geo2.y * 0.5 * (0.7 + 0.6*h3);
  let a = H * 0.5;
  let tipH = a * ${1 + G_CF};
  let N = terrainN(bxz);
  var axis = normalize(mix(N, vec3f(0.0, 1.0, 0.0), 0.5)) + vec3f(h2 - 0.5, 0.0, h3 - 0.5) * 0.4;
  if (u.camUp.w > 0.5) {
    // 偽草の筋の平行移動量 (0.6·wamp) と先端の変位が一致するよう軸を傾ける
    let time = u.camPos.w;
    let wamp = 0.10*sin(time*1.9 + bxz.x*0.35 + bxz.y*0.22) + 0.05*sin(time*3.7 + bxz.y*0.53 + bxz.x*0.31);
    axis += vec3f(0.86, 0.0, 0.5) * (wamp * 0.6 / max(tipH, 0.05));
  }
  axis = normalize(axis);
  let center = base + axis * (a * ${G_CF});
  // カメラ方向に正対するクアッド。楕円体の正射影の半幅 sqrt(v^T M v) に、
  // 透視でシルエットが中心面より外に出る分の余裕を掛ける
  let toC = center - u.camPos.xyz;
  let dc = length(toC);
  let Vc = toC / dc;
  var Rq = cross(Vc, vec3f(0.0, 1.0, 0.0));
  Rq = select(normalize(Rq), vec3f(1.0, 0.0, 0.0), dot(Rq, Rq) < 1e-6);
  let Uq = cross(Rq, Vc);
  let ra = dot(Rq, axis);
  let ua = dot(Uq, axis);
  let hw = sqrt(a*a*ra*ra + r*r*(1.0 - ra*ra));
  let hh = sqrt(a*a*ua*ua + r*r*(1.0 - ua*ua));
  let ext = max(a, r);
  let m = min(dc / sqrt(max(dc*dc - ext*ext, 0.01*ext*ext)), 3.0) * 1.05 * step(1e-4, fade);
  let cx = f32(vi & 1u) * 2.0 - 1.0;
  let cy = f32(vi >> 1u) * 2.0 - 1.0;
  let wp = center + Rq * (cx * hw * m) + Uq * (cy * hh * m);
  var o: GOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.center = center;
  o.axis = axis;
  o.prm = vec4f(a, r, u.geo.w * fade, 0.0);
  // 偽草と同じ「1本1色」: 色の式も偽草 (surfaceColor の草オーバーレイ) に揃える。
  // 偽草は遠方でミップ平均され detB→1 (rd→ρ) に収束するので、株の密度ゲイン 1.0 で
  // geometry on/off の画面平均色が一致する (実測)。ばらつきは平均より暗い側に寄せる
  let sun = u.sunDir.xyz;
  let ndl = max(dot(N, sun), 0.0);
  let detB = u.geo2.z * (0.8 + 0.6*h2);
  let shade = 1.35 - 0.52 * min(rho * (0.25 + 0.75*detB), 2.2);
  var galb = mix(ROOT_COL, TIP_COL, 0.6) * shade;
  if (u.misc.x < 0.5) { galb *= patchTint(bxz); }
  o.col = galb * (SUN_COL*ndl*0.9 + SKY_AMB*0.75)
        + TRANS_COL * pow(max(dot(Vc, sun), 0.0), 6.0) * 0.25;
  return o;
}
// 深度はクアッド平面のまま (楕円体表面の深度を frag_depth で書くと early-z が効かず
// 131k 本で約 15% 遅い。同色の柔らかい草どうしでは見た目の差が出ない)
@fragment fn fsGrass(in: GOut) -> @location(0) vec4f {
  let O = u.camPos.xyz;
  let D = normalize(in.wp - O);
  let A = normalize(in.axis);
  let a = in.prm.x;
  let r = in.prm.y;
  // 楕円体を単位球に写す座標 (軸方向 1/a, 直交方向 1/r) でレイと交差
  let o = O - in.center;
  let oa = dot(o, A);
  let da = dot(D, A);
  let op = (o - A*oa) / r + A * (oa / a);
  let dp = (D - A*da) / r + A * (da / a);
  let bq = dot(op, dp);
  let aq = dot(dp, dp);
  let cq = dot(op, op) - 1.0;
  let disc = bq*bq - aq*cq;
  if (disc <= 0.0) { discard; }
  let sq = sqrt(disc);
  let t1 = (-bq + sq) / aq;
  if (t1 <= 0.0) { discard; }
  let te = max((-bq - sq) / aq, 0.0);
  let P = O + D * te;
  // 密度 (1-s²) の球内線積分は単位球での半弦 hc の 3 乗に比例する。
  // 1 乗ぶんを世界での半弦 Lw/r に置き換え、軸方向に長い楕円体を見下ろすほど厚くする
  let hc2 = disc / aq;
  let Lw = sq / aq;
  let tau = in.prm.z * hc2 * Lw / r;
  var alpha = 1.0 - exp(-tau);
  let dist = length(P - O);
  let c = applyFog(in.col, dist, dot(D, u.sunDir.xyz));
  if (u.geo2.w > 0.5) {
    // alpha-to-coverage は MSAA サンプル数に量子化されるので、1 段ぶんの画面ディザで滑らかにする
    let ign = fract(52.9829189 * fract(0.06711056*in.pos.x + 0.00583715*in.pos.y));
    alpha = alpha + (ign - 0.5) * 0.25;
  }
  return vec4f(tonemap(c), clamp(alpha, 0.0, 1.0));
}

// --- 方向ぼかし詳細テクスチャのビューア (赤線が各層のぼかし方向) ---
struct OOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vsOverlay(@builtin(vertex_index) vi: u32) -> OOut {
  let corner = vec2f(f32(vi % 2u), f32((vi / 2u) % 2u));
  let hw = ${OV_COLS}.0 * 0.15 / u.camRight.w;
  let hh = ${OV_ROWS}.0 * 0.15;
  var o: OOut;
  o.pos = vec4f(mix(-hw, hw, corner.x), mix(-hh, hh, corner.y), 0.0, 1.0);
  o.uv = vec2f(corner.x, 1.0 - corner.y);
  return o;
}
@fragment fn fsOverlay(in: OOut) -> @location(0) vec4f {
  let grid = vec2f(${OV_COLS}.0, ${OV_ROWS}.0);
  let tile = min(floor(in.uv * grid), grid - vec2f(1.0));
  let layer = min(i32(tile.y * ${OV_COLS}.0 + tile.x), ${NDIR - 1});
  let tuv = fract(in.uv * grid);
  // 全域を縮小するとぼかし長 (数十cm) が見えないので、カメラ位置周辺の
  // 同一領域 (約2.6m四方) を全タイル共通で拡大表示する
  let cuv = u.camPos.xz / ${DETAIL_SPAN} + (tuv - vec2f(0.5)) * 0.25;
  let v = textureSampleLevel(detailArr, sampR, cuv, layer, 0.0).r;
  var c = vec3f(clamp((v - 0.05) * 1.3, 0.0, 1.0)) * vec3f(0.6, 0.8, 0.45);
  let th = f32(layer) * PI / ${NDIR}.0;
  let dirv = vec2f(cos(th), sin(th));
  let p = tuv - vec2f(0.5);
  if (abs(dot(p, vec2f(-dirv.y, dirv.x))) < 0.010 && abs(dot(p, dirv)) < 0.13) {
    c = mix(c, vec3f(1.0, 0.25, 0.2), 0.85);
  }
  if (min(tuv.x, tuv.y) < 0.010 || max(tuv.x, tuv.y) > 0.990) {
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
  var acc = vec2f(0.0);
  var wsum = 0.0;
  for (var t = -8; t <= 8; t++) {
    let w = exp(-f32(t*t) * 0.05);
    acc += vec2f(
      textureSampleLevel(src, s2, uv + bu.dir.xy * f32(t), 0.0).r,
      textureSampleLevel(src, s2, uv + bu.dir.zw * f32(t), 0.0).r) * w;
    wsum += w;
  }
  return vec4f(acc / wsum, 0.0, 1.0);
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
  device.onuncapturederror = e => { console.error('webgpu:', e.error.message); hud.textContent = 'GPU ERROR: ' + e.error.message; };
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
  {
    const h = new Uint16Array(TEX * TEX);
    for (let i = 0; i < h.length; i++) h[i] = toHalf(rho[i]);
    device.queue.writeTexture({ texture: rhoTex }, h, { bytesPerRow: TEX * 2, rowsPerImage: TEX }, [TEX, TEX, 1]);
  }

  const samp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge', maxAnisotropy: 16,
  });
  const sampR = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 16,
  });

  const { det, mean: detMean } = genDetail();
  const detMipCount = Math.log2(DETAIL_TEX) + 1;
  const detailTex = device.createTexture({
    size: [DETAIL_TEX, DETAIL_TEX], format: 'r16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // レイヤー i の rg = 方位 (i, i+1) のペア。g は次レイヤーの r と同値の重複だが、
  // サンプリング側の方位補間が 1 fetch になる
  const detailArr = device.createTexture({
    size: [DETAIL_TEX, DETAIL_TEX, NDIR], format: 'rg16float', mipLevelCount: detMipCount,
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
    const mkPipe = (entryPoint, format) => device.createRenderPipeline({
      layout: 'auto',
      vertex: { module: blurMod, entryPoint: 'vsFull' },
      fragment: { module: blurMod, entryPoint, targets: [{ format }] },
      primitive: { topology: 'triangle-list' },
    });
    const blurPipe = mkPipe('fsBlur', 'rg16float');
    const mipPipeR = mkPipe('fsMip', 'r16float');
    const mipPipeRG = mkPipe('fsMip', 'rg16float');
    const enc = device.createCommandEncoder();
    // dir.xy に方位 i、dir.zw に方位 i+1 (i+1 = NDIR は θ=π で、ぼかしの対称性により方位 0 と同じ)
    const blurDirs = (srcTex, dstTex, stepM, span, blurSamp) => {
      for (let dir = 0; dir < NDIR; dir++) {
        const th0 = dir * Math.PI / NDIR;
        const th1 = (dir + 1) * Math.PI / NDIR;
        const bu = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(bu, 0, new Float32Array([
          Math.cos(th0) * stepM / span, Math.sin(th0) * stepM / span,
          Math.cos(th1) * stepM / span, Math.sin(th1) * stepM / span,
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
    // タップ間隔 0.05m ±8 → 葉幅 4cm に対して縦横比 ~10:1 の筋
    blurDirs(detailTex, detailArr, 0.05, DETAIL_SPAN, sampR);
    const genMips = (tex, layers, levels, mipPipe) => {
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
    genMips(rhoTex, 1, mipCount, mipPipeR);
    genMips(detailArr, NDIR, detMipCount, mipPipeRG);
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
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  });
  const uBuf = device.createBuffer({ size: 208, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const chunkBuf = device.createBuffer({ size: G_MAX_CHUNKS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const chunkData = new Float32Array(G_MAX_CHUNKS * 4);
  const bindA = device.createBindGroup({
    layout: layoutA,
    entries: [
      { binding: 0, resource: { buffer: uBuf } },
      { binding: 1, resource: samp },
      { binding: 2, resource: rhoTex.createView() },
      { binding: 3, resource: detailArr.createView({ dimension: '2d-array' }) },
      { binding: 4, resource: sampR },
      { binding: 5, resource: { buffer: chunkBuf } },
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
    vertex: { module: sceneMod, entryPoint: 'vsGrass' },
    fragment: { module: sceneMod, entryPoint: 'fsGrass', targets },
    primitive: { topology: 'triangle-strip', cullMode: 'none' },
    depthStencil: depthOn,
    multisample: { count: MSAA, alphaToCoverageEnabled: true },
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
    barsOn: true, windOn: true, rhoOverlay: false, paused: false, flatGround: false,
    sunAz: 2.4, sunEl: 0.66, kOpacity: 4.0,
    geomOn: true, bpc: 4, gRadius: 25, gSoft: 0.6, gSigma: 3.0, gDens: 1.0, dither: true,
    gHeight: parseFloat(q.get('gh') || '0.5'), gWidth: parseFloat(q.get('gw') || '0.1'),
    lMin: parseFloat(q.get('lmin') || '1.0'),
    meltR: parseFloat(q.get('melt') || '1.0'),
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
    if (k === 'b') state.barsOn = !state.barsOn;
    if (k === 't') state.rhoOverlay = !state.rhoOverlay;
    if (k === 'v') state.windOn = !state.windOn;
    if (k === 'p') state.paused = !state.paused;
    if (k === 'n') state.flatGround = !state.flatGround;
    if (k === '1') state.sunAz -= 0.15;
    if (k === '2') state.sunAz += 0.15;
    if (k === '7') state.kOpacity = Math.max(0.2, state.kOpacity / 1.3);
    if (k === '8') state.kOpacity = Math.min(30, state.kOpacity * 1.3);
    if (k === 'g') state.geomOn = !state.geomOn;
    if (k === 'x') state.dither = !state.dither;
    if (k === '3') state.bpc = Math.max(1, state.bpc - 1);
    if (k === '4') state.bpc = Math.min(G_MAX_BPC, state.bpc + 1);
    if (k === '5') state.gRadius = Math.max(5, state.gRadius / 1.25);
    if (k === '6') state.gRadius = Math.min(200, state.gRadius * 1.25);
    if (k === '9') state.gSigma = Math.max(0.2, state.gSigma / 1.3);
    if (k === '0') state.gSigma = Math.min(50, state.gSigma * 1.3);
    if (k === ',') state.gSoft = Math.max(0.05, state.gSoft - 0.05);
    if (k === '.') state.gSoft = Math.min(0.95, state.gSoft + 0.05);
    if (k === '[') state.gDens = Math.max(0.2, state.gDens / 1.15);
    if (k === ']') state.gDens = Math.min(6, state.gDens * 1.15);
    if (k === '-') state.lMin = Math.max(0.02, state.lMin / 1.25);
    if (k === '=') state.lMin = Math.min(5, state.lMin * 1.25);
    if (k === 'h') state.gHeight = Math.max(0.05, state.gHeight / 1.15);
    if (k === 'j') state.gHeight = Math.min(5, state.gHeight * 1.15);
    if (k === 'k') state.gWidth = Math.max(0.005, state.gWidth / 1.15);
    if (k === 'l') state.gWidth = Math.min(1, state.gWidth * 1.15);
  });
  window.addEventListener('keyup', e => state.keys.delete(e.key.toLowerCase()));

  window.demo = {
    state,
    // 非表示タブでは rAF が止まるので、計測用に 1 フレームだけ手動で描く
    renderOnce() { frame(performance.now()); },
    device,
    setCam(x, y, z, yaw, pitch) {
      state.pos = [x, y, z]; state.yaw = yaw; state.pitch = pitch;
    },
    terrainH: terrainHJS,
    // rg16float はテクセルあたり half が2つ返る (r,g 交互のフラット配列)
    async readTex(tex, layer, x, y, w) {
      const bpt = tex.format === 'rg16float' ? 4 : 2;
      const buf = device.createBuffer({ size: Math.max(w * bpt, 256), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex, origin: [x, y, layer] },
        { buffer: buf, bytesPerRow: Math.max(w * bpt, 256) },
        [w, 1, 1]);
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const h = new Uint16Array(buf.getMappedRange().slice(0, w * bpt));
      const out = [...h].map(v => {
        const s = (v & 0x8000) ? -1 : 1, e = (v >> 10) & 0x1f, m = v & 0x3ff;
        if (e === 0) return s * m * Math.pow(2, -24);
        return s * (1 + m / 1024) * Math.pow(2, e - 15);
      });
      buf.unmap();
      return out;
    },
    tex: { get rho() { return rhoTex; }, get detail() { return detailArr; } },
  };

  // --- frame loop ---
  const uData = new Float32Array(52);

  // チャンク AABB の 8 頂点が同じクリップ平面の外側に揃ったら不可視
  function chunkVisible(vp, ox, oz, y0, y1) {
    let outMask = 0x3f;
    for (let i = 0; i < 8; i++) {
      const x = ox + (i & 1) * G_CHUNK, z = oz + ((i >> 1) & 1) * G_CHUNK, y = (i & 4) ? y1 : y0;
      const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
      const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
      const cz = vp[2] * x + vp[6] * y + vp[10] * z + vp[14];
      const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
      let m = 0;
      if (cx < -cw) m |= 1; if (cx > cw) m |= 2;
      if (cy < -cw) m |= 4; if (cy > cw) m |= 8;
      if (cz < 0) m |= 16; if (cz > cw) m |= 32;
      outMask &= m;
      if (!outMask) return true;
    }
    return false;
  }
  function collectChunks(vp, pos) {
    const R = state.gRadius;
    const draws = [];
    let n = 0, blades = 0;
    const c0x = Math.floor((pos[0] - R) / G_CHUNK), c1x = Math.floor((pos[0] + R) / G_CHUNK);
    const c0z = Math.floor((pos[2] - R) / G_CHUNK), c1z = Math.floor((pos[2] + R) / G_CHUNK);
    outer: for (let cz = c0z; cz <= c1z; cz++) for (let cx = c0x; cx <= c1x; cx++) {
      const ox = cx * G_CHUNK, oz = cz * G_CHUNK;
      const nx = Math.min(Math.max(pos[0], ox), ox + G_CHUNK);
      const nz = Math.min(Math.max(pos[2], oz), oz + G_CHUNK);
      const dens = 1 - sstep(R * (1 - state.gSoft), R, Math.hypot(pos[0] - nx, pos[2] - nz));
      // rank = (k + hc)/bpc · s < dens を満たす k の個数 (s は VS の順位縮小率)
      const rankScale = Math.max(1 - G_BAND / state.bpc, 0.5);
      const kCount = Math.min(state.bpc, Math.ceil(dens * state.bpc / rankScale));
      if (kCount <= 0) continue;
      let y0 = Infinity, y1 = -Infinity;
      for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
        const h = terrainHJS(ox + i * G_CHUNK / 2, oz + j * G_CHUNK / 2);
        y0 = Math.min(y0, h); y1 = Math.max(y1, h);
      }
      if (!chunkVisible(vp, ox, oz, y0 - 1, y1 + state.gHeight * 1.5 + 1)) continue;
      chunkData.set([ox, oz, cx, cz], n * 4);
      const inst = kCount * G_CELLS * G_CELLS;
      draws.push([inst, n]);
      blades += inst;
      if (++n >= G_MAX_CHUNKS) break outer;
    }
    return { draws, n, blades };
  }
  let prev = performance.now();
  let fpsAcc = 0, fpsN = 0, fpsT = 0;

  function frame(now) {
    const dt = Math.min((now - prev) / 1000, 0.1);
    prev = now;
    if (!state.paused) state.time += dt;
    fpsAcc += dt; fpsN++;
    if ((fpsT += dt) > 0.5) { state.fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0; fpsT = 0; }

    const speed = state.keys.has('shift') ? 60 : state.keys.has('control') ? 4 : 12;
    const cy = Math.cos(state.yaw), sy = Math.sin(state.yaw);
    if(state.keys.has('control')) {
      if (state.keys.has('a')) { state.yaw += 0.006 }
      if (state.keys.has('d')) { state.yaw -= 0.006 }
    }
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
    uData.set(viewProj, 0);
    uData.set([pos[0], pos[1], pos[2], state.time], 16);
    uData.set([fwd[0], fwd[1], fwd[2], Math.tan(fovY / 2)], 20);
    uData.set([right[0], right[1], right[2], aspect], 24);
    uData.set([up[0], up[1], up[2], state.windOn ? 1 : 0], 28);
    uData.set([sun[0], sun[1], sun[2], state.barsOn ? 1 : 0], 32);
    uData.set([state.kOpacity, SLAB_H, mean, detMean], 36);
    uData.set([state.flatGround ? 1 : 0, state.lMin, state.meltR, 0], 40);
    uData.set([state.gRadius * (1 - state.gSoft), state.gRadius, state.bpc, state.gSigma], 44);
    uData.set([state.gHeight, state.gWidth, state.gDens, state.dither ? 1 : 0], 48);
    device.queue.writeBuffer(uBuf, 0, uData);
    const chunksInfo = state.geomOn ? collectChunks(viewProj, pos) : { draws: [], n: 0, blades: 0 };
    if (chunksInfo.n > 0) device.queue.writeBuffer(chunkBuf, 0, chunkData, 0, chunksInfo.n * 4);

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
    if (chunksInfo.draws.length) {
      pass.setPipeline(grassPipe);
      for (const [inst, slot] of chunksInfo.draws) pass.draw(4, inst, 0, slot * G_MAX_INST);
    }
    if (state.rhoOverlay) {
      pass.setPipeline(overlayPipe);
      pass.draw(4);
    }
    pass.end();
    device.queue.submit([enc.finish()]);

    const detMB = DETAIL_TEX * DETAIL_TEX * NDIR * 4 * 4 / 3 / 1048576;
    hud.textContent =
      `fps ${state.fps.toFixed(0)}  density ${densMs.toFixed(0)}ms  blur ${blurMs.toFixed(0)}ms\n` +
      `ndir ${NDIR}  dtex ${DETAIL_TEX}px / dspan ${DETAIL_SPAN}m (${(DETAIL_SPAN / DETAIL_TEX * 100).toFixed(1)}cm/texel)  mem ${detMB.toFixed(1)}MB\n` +
      `bars[B] ${state.barsOn ? 'on' : 'off'}  wind[V] ${state.windOn ? 'on' : 'off'}  ` +
      `viewer[T] ${state.rhoOverlay ? 'on' : 'off'}  flat[N] ${state.flatGround ? 'on' : 'off'}\n` +
      `opacity[7/8] ${state.kOpacity.toFixed(1)}  lmin[-/=] ${state.lMin.toFixed(2)}m  melt ${state.meltR.toFixed(1)}m  sun[1/2] ${(state.sunAz * 180 / Math.PI).toFixed(0)}°\n` +
      `geom[G] ${state.geomOn ? 'on' : 'off'}  blades ${(chunksInfo.blades / 1000).toFixed(0)}k / ${chunksInfo.n} chunks  ` +
      `bpc[3/4] ${state.bpc}  radius[5/6] ${state.gRadius.toFixed(0)}m  soft[,/.] ${state.gSoft.toFixed(2)}  sigma[9/0] ${state.gSigma.toFixed(1)}  dither[X] ${state.dither ? 'on' : 'off'}\n` +
      `height[H/J] ${(state.gHeight * 100).toFixed(0)}cm  width[K/L] ${(state.gWidth * 100).toFixed(1)}cm  shade-dens[[/]] ${state.gDens.toFixed(2)}\n` +
      `drag:look  WASD:move  R/F:up/down  Shift:fast  P:pause`;
  }
  function frameWrap(now) {
    try {
      frame(now);
    } catch (e) {
      console.error(e);
      hud.textContent = 'frame error: ' + ((e && e.message) || e);
    }
    requestAnimationFrame(frameWrap);
  }
  requestAnimationFrame(frameWrap);
}

main().catch(e => {
  console.error(e);
  const el = document.getElementById('err');
  el.style.display = 'grid';
  el.textContent = String(e);
});
