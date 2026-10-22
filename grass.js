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
// 等方層 (layer NDIR、カメラ足元用) の σ [texel] と振幅係数。σ を上げて方向ぼかしと分散を
// 揃えると粒が 20cm 級に太るので、σ は葉幅程度に留めて平均まわりの振幅を縮める
// (標準偏差は方向層 0.119 に対し 0.117 で一致)
const ISO_SIGMA = 1.5;
const ISO_GAIN = 0.7;
// 短いぼかし: 長いぼかしに対する長さの比と、平均まわりの振幅係数 (長いぼかしと分散を揃える)
const SHORT_RATIO = parseFloat(q.get('short') || '0.25');
const SHORT_GAIN = parseFloat(q.get('shortGain') || '0.7');
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

// 草株 (tussock) の実験ノブ。URL パラメータで上書き
const tq = (name, def) => parseFloat(q.get(name) ?? def);
const T_P = {
  r: tq('tr', 1),          // 半径 [m]
  h: tq('th', 2),          // 地面からの高さ [m]
  cf: tq('tcf', 0.3),      // 楕円体中心の高さ (半長軸比)。残りは地中
  cell: tq('tcell', 4),    // 配置セル [m]
  prob: tq('tprob', 0.6),  // セルあたりの出現確率 (マクロ密度で変調)
  R: tq('tR', 150),        // 描画半径 [m]
  kc: tq('tkc', 2),        // 芯 (暗い塊) の光学的厚さ。弦が芯の直径のとき 1−exp(−kc)
  cr: tq('tcr', 0.75),     // 芯の半径 (殻の楕円体との相似比)
  ks: tq('tks', 0.7),      // 葉の殻の光学的厚さ。正面で密度 1 のとき 1−exp(−ks)
  lmax: tq('tlmax', 1),    // 殻の見かけ厚みの上限 (正面を 1 として、縁のグレージングで伸びる分)
  org: tq('torg', -0.5),     // 針が生える原点の高さ [m] (根元 = 地面を 0 とし、軸に沿って測る。負で地中)
  bend: tq('tbend', 0.2),  // 風で倒す量 (突風 1 のとき、株の高さに対する先端の変位の比)
  gf: tq('tgf', 0.15),     // 地面との境目のフェード幅 [m] (根元の接平面からの鉛直高さ)
  gm: tq('tgm', 0.04),     // 接平面近似の誤差の見込み [m]。縮めた帯がこれより薄い視線角ではフェードしない
  rim0: tq('trim0', 0.6),  // 縁のしきい値が立ち上がる衝突径数 ρ (正射影の円板での中心からの距離)
  rimT: tq('trimt', 2.0),  // 輪郭 (ρ = 1) での密度しきい値 (平均 1、筋のピーク ~2.4)
  wrap: tq('twrap', 0.5),  // 楕円体法線の wrap lighting 量 (影側を持ち上げる)
  leaf: (q.get('tleaf') || '0.4,0.5,0.1').split(',').map(Number),  // 葉の色 (単色、草原と別種のオリーブ)
  core: (q.get('tcore') || '0.08,0.1,0.02').split(',').map(Number),  // 芯の色
  k: tq('tk', 1.5),        // 方位図法の倍率 (赤道 1 周ぶんの弧に貼るタイル数)
  iso: tq('tiso', 0.25),   // 等方タイル (針を真正面から見た点々) へ混ぜる像の長さの上限
  nb: tq('tnb', 24),       // 株あたりのブレード数
  bl: tq('tbl', 0.35),     // ブレード長 [m]
  bw: tq('tbw', 0.012),    // ブレード幅 [m]
  br: tq('tbr', 30),       // ブレード描画半径 [m]
  debug: tq('tdebug', 0),  // 1: 詳細密度, 2: 表面 uv の格子, 3: 像の長さ (R) / 等方 (G) / 短 (B) の重み
};

// 株メッシュ: 緯度経度の半球 + 裾。遠景は粗いメッシュ、近景 (ブレードと同じ内側グリッド) は細かいメッシュ。
// 裾の縁 (極角 T_THETA_MAX) は根元の面から 0.5a 下。軸は地面法線から斜度の半分傾くので、
// 2.0 rad (0.18m 下) だと斜度 22° 以上で下り側の縁が地面の上に出て、低い視点から底の穴が見えた
const T_SEG_F = 24, T_RING_F = 14, T_SEG_C = 12, T_RING_C = 7;
const T_THETA_MAX = 2.5;
const T_LOD_BASE = 1 << 20;
const MSAA = 4;

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
// alpha-to-coverage は MSAA サンプル数に量子化されるので、1 段ぶんの画面ディザで滑らかにする。
// floor(alpha·N + 乱数)/N にすると alpha = 0 は必ず 0 のまま (alpha に乱数を足す形だと
// 透明な画素にも 1 サンプルが立ち、縁に点々の輪が残る)。位相 phase はインスタンスごとにずらし、
// 重なった半透明どうしでマスクが相関しないようにする
fn ditherAlpha(alpha: f32, pos: vec2f, phase: f32) -> f32 {
  let ign = fract(52.9829189 * fract(0.06711056*pos.x + 0.00583715*pos.y + phase));
  return floor(clamp(alpha, 0.0, 1.0) * ${MSAA}.0 + ign) / ${MSAA}.0;
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
  misc: vec4f,      // flatGround, 偽草の足元線分長 L の下限 (真上から見た葉の見かけの厚み), 詳細モード (0: 長+等方, 1: 長/短+等方, 2: 長/短), 突風の暗さの視線依存
  geo: vec4f,       // 密度フェード開始距離, 終了距離, bladesPerCell, sigma (葉の光学的厚さ)
  geo2: vec4f,      // height, width, 株の密度ゲイン (色の明暗), dither
  wind: vec4f,      // 突風で倒す量, 突風の暗さ, テクスチャのスクロール位相 [tile], タイル [m]
  tus: vec4f,       // 株の半径, 高さ, 芯の光学的厚さ kc, 殻の光学的厚さ ks
  tus2: vec4f,      // wrap lighting 量, 株あたりブレード数, ブレード長, ブレード幅
  tus3: vec4f,      // 株グリッドの一辺のセル数, セル [m], セルあたり確率, 描画半径
  tus4: vec4f,      // ブレードグリッドの一辺のセル数, ブレード描画半径, 殻の見かけ厚みの上限, 中心の高さ (半長軸比)
  tus5: vec4f,      // 方位図法の倍率, デバッグ表示, 縁のしきい値が立ち上がる ρ, 等方へ混ぜる像の長さの上限
  tusLeaf: vec4f,   // 葉の色, 輪郭での密度しきい値
  tusCore: vec4f,   // 芯の色, 針の原点の高さ (根元から軸に沿って)
  tus6: vec4f,      // 風で倒す量, 地面フェード幅, 芯の半径 (相似比), 接平面近似の誤差の見込み
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
@group(0) @binding(6) var windTex: texture_2d<f32>;
@group(0) @binding(7) var windSamp: sampler;

// 風の場。突風が一方向に走るので向きは固定で、突風テクスチャ (windtex.js) の r が風向成分 [0,1]、
// g が横成分 (0.5 ± 0.5、風向成分を事前に掛けてある)。テクスチャ空間の +x が風下
const WIND_DIR = vec2f(0.86449, 0.50261);
const WIND_PERP = vec2f(-0.50261, 0.86449);
fn windUV(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, WIND_DIR), -WIND_DIR.y*p.x + WIND_DIR.x*p.y);
  return q / u.wind.w - vec2f(u.wind.z, 0.0);
}
// (風向成分, 横成分)。頂点段では textureSampleLevel しか呼べない
fn windDecode(t: vec2f) -> vec2f {
  return vec2f(t.x, t.y * 2.0 - 1.0);
}
fn windField(p: vec2f) -> vec2f {
  return windDecode(textureSample(windTex, windSamp, windUV(p)).rg);
}
fn windFieldLevel(p: vec2f) -> vec2f {
  return windDecode(textureSampleLevel(windTex, windSamp, windUV(p), 0.0).rg);
}
// 葉を倒す水平ベクトル
fn windAt(wf: vec2f) -> vec2f {
  return (WIND_DIR * wf.x + WIND_PERP * wf.y) * u.wind.x;
}
// 風の中の草の明るさ倍率。倒れの大きさで暗くなり、倒れる向きに視線が沿うと (葉の列を覗き込んで
// 根元が見える) 更に暗く、向かってくる向きだと (先端の面が閉じる) 戻る
fn windGain(wf: vec2f, Vh: vec2f) -> f32 {
  let wv = WIND_DIR * wf.x + WIND_PERP * wf.y;
  let mag = length(wv);
  let lh = length(Vh);
  let along = select(0.0, dot(Vh, wv) / (lh * mag), lh > 1e-5 && mag > 1e-5);
  return 1.0 - u.wind.y * mag * (1.0 + u.misc.w * along);
}

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
// 各レイヤーの rg は長いぼかし、ba は同じ方位の短いぼかし (SHORT_RATIO 倍) で、short で混ぜる。
// 像が短い所 (視線が軸に沿う点の近く) では短いぼかしにすると放射模様の出る半径が縮む。
// iso > 0 の画素では層 NDIR (方向ぼかしなしの等方タイル) を追加で引いて混ぜる。
// 非一様な分岐の中でサンプルするため、勾配は分岐の外で取って textureSampleGrad に渡す
fn latticeDetail(p: vec2f, windW: vec2f, thetaView: f32, beta: f32, iso: f32, short: f32) -> f32 {
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
  let d = textureSample(detailArr, sampR, duv, i32(i0));
  var v = mix(mix(d.x, d.y, fw), mix(d.z, d.w, fw), short);
  let ddx = dpdx(duv);
  let ddy = dpdy(duv);
  if (iso > 0.0) {
    v = mix(v, textureSampleGrad(detailArr, sampR, duv, ${NDIR}, ddx, ddy).r, iso);
  }
  return v;
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
    // 風: 参照位置のオフセット (筋全体の平行移動) と、葉の軸の傾き。同じ場・同じ倒し量を
    // 近景ブレードにも使う
    var wf = vec2f(0.0);
    if (u.camUp.w > 0.5) { wf = windField(wp.xz); }
    let w = windAt(wf);
    let windW = w * 0.09;
    let axis = normalize(N + vec3f(w.x, 0.0, w.y) * 0.45);
    // 葉の像は軸を視線に沿って地面へ落としたものなので、ぼかし方位はその投影から取る。
    // 立った葉なら視線方位 (カメラ足元から放射状) に一致し、倒れた葉は視線が立つほど風下へ
    // 回る。向きが変わらないと、風はテクスチャの平行移動にしか見えない。
    // 方位量子化は隣接2方位の lerp (ぼかしは対称なので 180° 周期、符号処理は不要)
    var rh = axis.xz - axis.y * V.xz / min(V.y, -1e-3);
    let lh = length(rh);  // 像の長さ (軸長 1 あたり)。視線が軸に沿う点で 0
    rh = select(rh / lh, vec2f(1.0, 0.0), lh < 1e-5);
    let thetaView = atan2(rh.y, rh.x);
    // 2格子を半量子 (π/2NDIR) 回転差で重ねる: 回転角が格子と非通約なので合成場は
    // 非周期になり、方向量子化の誤差も格子間で非相関化される。
    // 2枚の和 (÷2) を表現したい場そのものとみなし、分散の √2 復元はしない
    // (復元すると最大値が範囲を超え、濃部にベタ塗りが出る)
    // 像が潰れる点 (視線が軸に沿う所。立った葉ならカメラ足元) の周りでは 1 本の筋の中で方位が
    // 曲がり、放射模様として見える。そこは方向ぼかしなしの等方タイルへ混ぜる (タイル平均へ
    // 寄せると模様の無い円盤がカメラに追従して見える)。範囲は像の長さ lh で取るので、風で
    // 軸が倒れて潰れる点が動いても、場所ごとに違っても追従する。立った葉では lh = 水平距離/Δy
    // なので、「水平 2m」と「鉛直から tan 0.1 の円錐」の soft な min になる: 地上では筋長
    // (~0.8m) の数倍、高高度では狭い円錐なので追加フェッチは少ない
    let dy = abs(wp.y - u.camPos.y);
    let tv = lh * dy / (20.0 + dy);
    var isoW = 1.0 - smoothstep(0.0, 0.1, tv);
    var shortW = 0.0;
    if (u.misc.z > 0.5) {
      // 長いぼかしの長さを草の公称高さとみなすと、地面上の像の長さはその lh 倍。像が短いぼかしの
      // 長さ比まで縮む所で短いぼかしに切り替え、間は混ぜる。等方はぼかし長の比だけ縮んだ
      // 範囲にだけ残す (モード 2 では無し)
      shortW = 1.0 - smoothstep(${SHORT_RATIO}, 1.0, lh);
      isoW = select(0.0, 1.0 - smoothstep(0.0, 0.1 * ${SHORT_RATIO}, tv), u.misc.z < 1.5);
    }
    let dsum = (latticeDetail(wp.xz, windW, thetaView, 0.0, isoW, shortW)
              + latticeDetail(wp.xz, windW, thetaView, ${Math.PI / (2 * NDIR)}, isoW, shortW)) * 0.5;
    let detN = dsum / max(u.par.w, 1e-3);
    // 正規化で潰れた振幅を偏差ゲインで戻す (0 クランプは max で滑らかに回避)
    let detB = max(1.0 + (detN - 1.0) * 2.4, 0.05);
    let sinG = clamp(abs(dot(V, N)), 0.02, 1.0);
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
    var galb = mix(ROOT_COL, TIP_COL, 0.6) * shade * windGain(wf, V.xz);
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
  let N = terrainN(bxz);
  var axis = normalize(mix(N, vec3f(0.0, 1.0, 0.0), 0.5)) + vec3f(h2 - 0.5, 0.0, h3 - 0.5) * 0.4;
  var wf = vec2f(0.0);
  if (u.camUp.w > 0.5) {
    // 偽草 (surfaceColor) と同じ場・同じ倒し量
    wf = windFieldLevel(bxz);
    let w = windAt(wf);
    axis += vec3f(w.x, 0.0, w.y) * 0.45;
  }
  axis = normalize(axis);
  let center = base + axis * (a * ${G_CF});
  let Vc = normalize(center - u.camPos.xyz);
  let wp = impostorQuad(center, axis, a, r, vi, fade);
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
  var galb = mix(ROOT_COL, TIP_COL, 0.6) * shade * windGain(wf, Vc.xz);
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
  let r = in.prm.y;
  let h = ellipsoidHit(O, D, in.center, normalize(in.axis), in.prm.x, r);
  if (!h.hit) { discard; }
  // 密度 (1-s²) の球内線積分は単位球での半弦 hc の 3 乗に比例する。
  // 1 乗ぶんを世界での半弦 Lw/r に置き換え、軸方向に長い楕円体を見下ろすほど厚くする
  let tau = in.prm.z * h.hc2 * h.Lw / r;
  var alpha = 1.0 - exp(-tau);
  let dist = length(h.P - O);
  let c = applyFog(in.col, dist, dot(D, u.sunDir.xyz));
  if (u.geo2.w > 0.5) { alpha = ditherAlpha(alpha, in.pos.xy, in.prm.w); }
  return vec4f(tonemap(c), clamp(alpha, 0.0, 1.0));
}

// カメラ方向に正対するクアッド。楕円体の正射影の半幅 sqrt(v^T M v) に、
// 透視でシルエットが中心面より外に出る分の余裕を掛ける。show が 0 なら潰す
fn impostorQuad(center: vec3f, axis: vec3f, a: f32, r: f32, vi: u32, show: f32) -> vec3f {
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
  let m = min(dc / sqrt(max(dc*dc - ext*ext, 0.01*ext*ext)), 3.0) * 1.05 * step(1e-4, show);
  let cx = f32(vi & 1u) * 2.0 - 1.0;
  let cy = f32(vi >> 1u) * 2.0 - 1.0;
  return center + Rq * (cx * hw * m) + Uq * (cy * hh * m);
}

struct EllHit { hit: bool, P: vec3f, hc2: f32, Lw: f32 }  // 手前の交点、単位球での半弦の 2 乗、世界での半弦
// 楕円体を単位球に写す座標 (軸方向 1/a, 直交方向 1/r) でレイと交差。
// 交差しない場合も disc を 0 で止めて有限の P を返す: discard されたフラグメントはヘルパーとして
// 続くので、シルエット際の勾配 (テクスチャの mip 選択) を NaN にしないため
fn ellipsoidHit(O: vec3f, D: vec3f, C: vec3f, A: vec3f, a: f32, r: f32) -> EllHit {
  let o = O - C;
  let oa = dot(o, A);
  let da = dot(D, A);
  let op = (o - A*oa) / r + A * (oa / a);
  let dp = (D - A*da) / r + A * (da / a);
  let bq = dot(op, dp);
  let aq = dot(dp, dp);
  let cq = dot(op, op) - 1.0;
  let disc = bq*bq - aq*cq;
  let sq = sqrt(max(disc, 0.0));
  let t1 = (-bq + sq) / aq;
  var h: EllHit;
  h.hit = disc > 0.0 && t1 > 0.0;
  h.P = O + D * max((-bq - sq) / aq, 0.0);
  h.hc2 = max(disc, 0.0) / aq;
  h.Lw = sq / aq;
  return h;
}

// --- 草株 (tussock): 回転楕円体インポスターの表面に Ripmap 草の筋を貼る ---
// 葉は 1 点 (原点。既定は根元で、株の中心にするとウニ) から放射状に生えているとみなす。殻の各点の
// 針の軸は原点からの方向で、その像は軸を視線に沿って殻の接平面へ落としたもの (草原の式の地面を
// 接平面に替えただけ)。筋の方位はその投影から取るので視線で変わり、視線が針に沿う点 (真上から見た頂点、
// 横から見た正面) では像が潰れて等方タイルの点々になる。タイルは上の極を中心にした方位図法
// (uv = θ·(cosφ, sinφ)) で天頂から被せて下まで巻き付ける (継ぎ目なし)。
// 色は 2 層: 単色の葉の殻を暗い芯の上に重ねる。殻の被覆率は詳細密度 d (レイが横切る葉の量) と
// 殻の見かけ厚み (正面で 1、縁のグレージングで伸びる) から、芯の不透明度は近景ジオメトリ草と
// 同じ「密度 (1−s²) の球内線積分」(中心で厚く縁で薄い) から取る。正面では殻が薄く芯の暗さが
// 針の隙間から透け、縁では葉で埋まり d の低い所は背景まで抜ける。筋のコントラストは
// 葉色 ↔ 芯色/背景 の差から出るので、密度で明るさは変えない。照明の法線は楕円体のもの
// (stylized な木の葉塊と同じ) で、wrap lighting で影側を持ち上げる
struct Tussock {
  base: vec3f, center: vec3f, axis: vec3f,
  a: f32, r: f32, keep: f32, rho: f32, rnd: f32,
  wf: vec2f, w: vec2f,
  slope: vec2f,  // 根元での地形の勾配 ∂h/∂x, ∂h/∂z
}
fn tussockAt(gx: i32, gz: i32) -> Tussock {
  var T: Tussock;
  let cell = u.tus3.y;
  let h0 = hash3f(gx, gz, 7000);
  let h1 = hash3f(gx, gz, 7001);
  let h2 = hash3f(gx, gz, 7002);
  let h3 = hash3f(gx, gz, 7003);
  let bxz = (vec2f(f32(gx), f32(gz)) + vec2f(h0, h1)) * cell;
  T.base = vec3f(bxz.x, meshH(bxz), bxz.y);
  T.rho = textureSampleLevel(rhoTex, samp, rhoUV(bxz), 0.0).r;
  T.keep = step(h2, u.tus3.z * smoothstep(0.2, 0.6, T.rho));
  let s = 0.75 + 0.5 * h3;
  T.r = u.tus.x * s;
  T.a = u.tus.y * s / (1.0 + u.tus4.w);
  let N = terrainN(bxz);
  T.slope = -N.xz / N.y;
  var axis = normalize(mix(N, vec3f(0.0, 1.0, 0.0), 0.5));
  T.wf = vec2f(0.0);
  T.w = vec2f(0.0);
  if (u.camUp.w > 0.5) {
    T.wf = windFieldLevel(bxz);
    T.w = windAt(T.wf);
  }
  T.axis = normalize(axis);
  T.center = T.base + T.axis * (T.a * u.tus4.w);
  T.rnd = hash3f(gx, gz, 7004);
  return T;
}
// 風の変形 D(x) = x + κ·max(y − y₀, 0)²·ŵ (y は軸に沿った高さ)。y を変えないので逆写像が閉じる。
// 支点 y₀ は原点・楕円体の下端・地面の最大 (地中に置くと地面の輪が横滑りする)。
// κ は先端 (高さ h) の変位が bend·|w|·h になるように取る
struct Bend { w: vec3f, kappa: f32, y0: f32 }  // ŵ (単位、|w| は kappa に込み)
fn tussockBend(T: Tussock) -> Bend {
  var b: Bend;
  let mag = length(T.w);
  b.w = select(vec3f(1.0, 0.0, 0.0), vec3f(T.w.x, 0.0, T.w.y) / max(mag, 1e-6), mag > 1e-6);
  let yTop = T.a * (1.0 + u.tus4.w);
  b.y0 = max(max(u.tusCore.w, -T.a * (1.0 - u.tus4.w)), 0.0);
  b.kappa = u.tus6.x * mag * yTop / max((yTop - b.y0) * (yTop - b.y0), 1e-4);
  return b;
}
fn bendDisp(b: Bend, y: f32) -> f32 { return b.kappa * max(y - b.y0, 0.0) * max(y - b.y0, 0.0); }
fn bendSlope(b: Bend, y: f32) -> f32 { return 2.0 * b.kappa * max(y - b.y0, 0.0); }
// 軸まわりの方位角の基準となる水平基底
fn tussockBx(A: vec3f) -> vec3f { return normalize(cross(vec3f(0.0, 0.0, 1.0), A)); }
// カメラ足元のセルを中心とした n×n グリッドのセル座標
fn tussockCell(ii: u32, n: u32) -> vec2i {
  let c0 = vec2i(floor(u.camPos.xz / u.tus3.y)) - vec2i(i32(n / 2u));
  return c0 + vec2i(i32(ii % n), i32(ii / n));
}
// 楕円体法線による照明 (wrap lighting)
fn tussockLight(n: vec3f, sun: vec3f) -> vec3f {
  let w = u.tus2.x;
  let ndl = clamp((dot(n, sun) + w) / (1.0 + w), 0.0, 1.0);
  return SUN_COL * ndl * 0.9 + SKY_AMB * 0.75;
}

struct TuOut {
  @builtin(position) pos: vec4f,
  @location(0) wp: vec3f,     // 変形後の位置
  @location(1) sph: vec3f,    // 変形前の面上の点 (単位球座標: 軸方向 /a、直交方向 /r)
  @location(2) center: vec3f,
  @location(3) axis: vec3f,
  @location(4) prm: vec4f,    // 半長軸 a, 半径 r, 距離フェード, 乱数 (タイルのオフセットとディザ位相)
  @location(5) wind: vec4f,   // 風の場 (風向成分, 横成分), 変形の ŵ.xz
  @location(6) origin: vec3f,
  @location(7) bend: vec2f,   // κ, y₀
  @location(8) gbase: vec3f,  // 根元 (地面フェードの基準面の通過点)
  @location(9) gslope: vec2f, // 根元での地形の勾配
}
// 株のメッシュは緯度経度の半球 + 裾 (極角 0 〜 ${T_THETA_MAX} rad) で、頂点は添字から生成する。
// 近景 (内側 m×m セル、firstInstance = ${T_LOD_BASE}) は ${T_SEG_F}×${T_RING_F}、遠景は ${T_SEG_C}×${T_RING_C}
const T_LOD_BASE = ${T_LOD_BASE}u;
@vertex fn vsTussock(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> TuOut {
  let fine = ii >= T_LOD_BASE;
  let inst = select(ii, ii - T_LOD_BASE, fine);
  let nFine = u32(u.tus4.x);
  let nAll = u32(u.tus3.x);
  var c: vec2i;
  var show = 1.0;
  if (fine) {
    c = tussockCell(inst, nFine);
  } else {
    c = tussockCell(inst, nAll);
    let cf = tussockCell(0u, nFine);
    let d = c - cf;
    if (d.x >= 0 && d.y >= 0 && d.x < i32(nFine) && d.y < i32(nFine)) { show = 0.0; }
  }
  let seg = select(${T_SEG_C}u, ${T_SEG_F}u, fine);
  let ring = select(${T_RING_C}u, ${T_RING_F}u, fine);
  let tri = vi / 3u;
  let corner = vi % 3u;
  let quad = tri / 2u;
  let i = quad / seg;
  let j = quad % seg;
  // 四角形 (i,j) の 2 三角形: (i,j)(i+1,j)(i,j+1) と (i+1,j)(i+1,j+1)(i,j+1)
  let odd = tri % 2u;
  let di = select(select(0u, 1u, corner == 1u), select(1u, 0u, corner == 2u), odd == 1u);
  let dj = select(select(0u, 1u, corner == 2u), select(0u, 1u, corner >= 1u), odd == 1u);
  let theta = f32(i + di) / f32(ring) * ${T_THETA_MAX};
  let phi = f32((j + dj) % seg) / f32(seg) * 2.0 * PI;
  let T = tussockAt(c.x, c.y);
  let d = distance(T.center, u.camPos.xyz);
  let fade = (1.0 - smoothstep(u.tus3.w * 0.85, u.tus3.w, d)) * T.keep * show;
  let Bx = tussockBx(T.axis);
  let Bz = cross(T.axis, Bx);
  let sph = vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
  let p0 = T.center + Bx * (T.r * sph.x) + T.axis * (T.a * sph.y) + Bz * (T.r * sph.z);
  let b = tussockBend(T);
  let y = dot(p0 - T.base, T.axis);
  let wp = p0 + b.w * bendDisp(b, y);
  var o: TuOut;
  o.pos = select(vec4f(0.0, 0.0, 2.0, 1.0), u.viewProj * vec4f(wp, 1.0), fade > 1e-4);
  o.wp = wp;
  o.sph = sph;
  o.center = T.center;
  o.axis = T.axis;
  o.prm = vec4f(T.a, T.r, fade, T.rnd);
  o.wind = vec4f(T.wf, b.w.xz);
  o.origin = T.base + T.axis * u.tusCore.w;
  o.bend = vec2f(b.kappa, b.y0);
  o.gbase = T.base;
  o.gslope = T.slope;
  return o;
}

// 株用の詳細タイル参照 (格子回転なし)。勾配は呼び出し側で与える (非一様な分岐の外で取る)
fn tussockDetail(duv: vec2f, theta: f32, ddx: vec2f, ddy: vec2f, iso: f32, short: f32) -> f32 {
  var tm = theta - floor(theta / PI) * PI;
  var i0 = floor(tm / (PI / ${NDIR}.0));
  let fw = tm / (PI / ${NDIR}.0) - i0;
  if (i0 > ${NDIR - 1}.5) { i0 = ${NDIR - 1}.0; }
  let d = textureSampleGrad(detailArr, sampR, duv, i32(i0), ddx, ddy);
  var v = mix(mix(d.x, d.y, fw), mix(d.z, d.w, fw), short);
  if (iso > 0.0) {
    v = mix(v, textureSampleGrad(detailArr, sampR, duv, ${NDIR}, ddx, ddy).r, iso);
  }
  return v;
}

@fragment fn fsTussock(in: TuOut) -> @location(0) vec4f {
  let O = u.camPos.xyz;
  let D = normalize(in.wp - O);
  let A = normalize(in.axis);
  let a = in.prm.x;
  let r = in.prm.y;
  let Bx = tussockBx(A);
  let Bz = cross(A, Bx);
  let sph = normalize(in.sph);
  let p0 = in.center + Bx * (r * sph.x) + A * (a * sph.y) + Bz * (r * sph.z);
  // 弦: 変形前の面上の点と視線を単位球座標に写すと、半弦は dot(sph, ds)/|ds|² で閉じる。
  // dot > 0 は裏面 (視線が出ていく側) なので捨てる
  let ds = vec3f(dot(D, Bx) / r, dot(D, A) / a, dot(D, Bz) / r);
  let pd = dot(sph, ds);
  let ds2 = dot(ds, ds);
  let hc2 = pd * pd / ds2;
  let rho = sqrt(max(1.0 - hc2, 0.0));
  // 変形 J = I + f'(y)·ŵ ⊗ Aᵀ。葉の接線は J·s₀、法線は J⁻ᵀ n₀
  let w3 = vec3f(in.wind.z, 0.0, in.wind.w);
  let y = dot(p0 - (in.center - A * (a * u.tus4.w)), A);
  let fp = 2.0 * in.bend.x * max(y - in.bend.y, 0.0);
  let n0 = normalize(Bx * (sph.x / r) + A * (sph.y / a) + Bz * (sph.z / r));
  let n = normalize(n0 - A * (fp * dot(w3, n0)));
  let s0 = normalize(p0 - in.origin);
  let t = normalize(s0 + w3 * (fp * dot(s0, A)));
  let lh = sqrt(max(1.0 - dot(t, D) * dot(t, D), 0.0));
  // 方位図法 uv = sc·θ·(cosφ, sinφ)。筋の向きは、接線を画面に投影した方向を uv の画面微分で
  // uv 空間へ写して得る (画面への投影が「視線に沿って接平面へ落とす」ことに当たるので、
  // 変形や楕円体のヤコビアンは要らない)
  let sc = u.tus5.x / (2.0 * PI);
  let theta = acos(clamp(sph.y, -1.0, 1.0));
  let phi = atan2(sph.z, sph.x);
  let off = vec2f(in.prm.w, h11(in.prm.w * 17.0));
  let uv = vec2f(cos(phi), sin(phi)) * (theta * sc) + off;
  let gx = dpdx(uv);
  let gy = dpdy(uv);
  let clip = u.viewProj * vec4f(in.wp, 1.0);
  let clipT = u.viewProj * vec4f(t, 0.0);
  let sdir = (clipT.xy - clip.xy * (clipT.w / clip.w)) / clip.w;
  // NDC → 画素: x はアスペクト倍、y は上下反転
  let tuv = gx * (sdir.x * u.camRight.w) - gy * sdir.y;
  let thetaUV = atan2(tuv.y, tuv.x);
  // 像が潰れる所は等方タイル (針を真正面から見た点々)、短い所は短いぼかし
  let isoW = 1.0 - smoothstep(0.0, u.tus5.w, lh);
  let shortW = 1.0 - smoothstep(${SHORT_RATIO}, 1.0, lh);
  let det = tussockDetail(uv, thetaUV, gx, gy, isoW, shortW);
  let detN = det / max(u.par.w, 1e-3);
  let detB = max(1.0 + (detN - 1.0) * 2.4, 0.05);
  // 殻: 見かけ厚みは正面で 1、グレージングで 1/|cos| (上限あり)。芯: 弦の長さ。
  // 縁 (衝突径数 ρ が大きい所) は密度にしきい値を掛け、濃い筋だけを輪郭まで届かせる。
  // 一様に薄くすると「薄い帯」になるだけで、グレージングの mip 平均 (≈ 平均密度) がそのまま
  // 均一な殻の縁に見える。しきい値なら平均は超えないので遠景では勝手に消える
  let g = min(1.0 / max(-dot(D, n), 0.05), u.tus4.z);
  let thr = u.tusLeaf.w * smoothstep(u.tus5.z, 1.0, rho);
  // 地面との交線は、根元の接平面 (画素では地形を引かない) からの鉛直高さ gf でぼかす。
  // スレスレの視線では帯の向こうの地面が透けて株が浮くので、帯の上端から視線を延ばした
  // 着地点が接地半径の内側 (株の足元) に収まる高さ b まで帯を縮める。帯が接平面の誤差 m より
  // 薄くなる角度では交線は地面の輪郭と重なって見えないので、効果ごと消して不透明にする
  // (接平面より下の画素も含め、hv = 0 にステップを作らない)
  let hv = in.wp.y - in.gbase.y - dot(in.gslope, in.wp.xz - in.gbase.xz);
  let Ng = normalize(vec3f(-in.gslope.x, 1.0, -in.gslope.y));
  let sinT = clamp(-dot(D, Ng), 0.0, 1.0);
  let tanT = sinT / sqrt(max(1.0 - sinT * sinT, 1e-6));
  let rc0 = r * sqrt(max(1.0 - u.tus4.w * u.tus4.w, 0.0));
  let b = rc0 * tanT;
  let gfEff = max(min(u.tus6.y, b), 1e-4);
  let gfade = mix(1.0, smoothstep(0.0, gfEff, hv), smoothstep(0.0, u.tus6.w, b));
  let fade = in.prm.z * gfade;
  let cs = (1.0 - exp(-u.tus.w * max(detB - thr, 0.0) * g)) * fade;
  // 芯は相似比 rc の内側の楕円体。密度は縁へ向かって (1−q²) で薄くなる柔らかい球とし、
  // 視線がそこを横切る半弦 (世界長 / r) を掛ける。一様な硬い球 (弦だけ) だと中心が平らで縁が急になる。
  // 縁には同じ窓を掛ける (弦だけでは薄い暗い輪が残り、殻の輪郭に見える)
  let rc = u.tus6.z;
  let q = rho / rc;
  let coreChord = sqrt(max(rc * rc - rho * rho, 0.0)) / sqrt(ds2);
  let rimW = 1.0 - smoothstep(u.tus5.z, 1.0, q);
  let cc = (1.0 - exp(-u.tus.z * max(1.0 - q * q, 0.0) * coreChord / r)) * rimW * fade;
  var alpha = 1.0 - (1.0 - cs) * (1.0 - cc);
  let sun = u.sunDir.xyz;
  let light = tussockLight(n, sun);
  let leaf = u.tusLeaf.rgb * light * windGain(in.wind.xy, D.xz)
           + TRANS_COL * pow(max(dot(D, sun), 0.0), 6.0) * 0.15;
  let core = u.tusCore.rgb * light;
  // 殻を芯の手前に置く (premultiplied の合成を alpha で割って straight に戻す。alpha ≈ 0 では葉色)
  var c = select(leaf, (leaf * cs + core * ((1.0 - cs) * cc)) / alpha, alpha > 1e-4);
  let dist = length(in.wp - O);
  c = applyFog(c, dist, dot(D, sun));
  if (u.geo2.w > 0.5) { alpha = ditherAlpha(alpha, in.pos.xy, in.prm.w); }
  if (pd > 0.0) { discard; }
  var o = vec4f(tonemap(c), clamp(alpha, 0.0, 1.0));
  if (u.tus5.y > 0.5) {
    let uvg = uv * 16.0;
    let grid = step(0.5, fract(uvg.x)) + step(0.5, fract(uvg.y));
    var dc = vec3f(detN * 0.5);
    if (u.tus5.y > 1.5) { dc = vec3f(select(0.2, 0.8, grid == 1.0)); }
    if (u.tus5.y > 2.5) { dc = vec3f(min(lh, 1.0), isoW, shortW); }
    if (u.tus5.y > 3.5) { dc = vec3f(cs, cc, 0.0); }
    o = vec4f(dc, 1.0);
  }
  return o;
}

// 近景: 原点から放射状のブレード (細長い楕円体インポスター) を殻の位置に重ねる。描画は fsGrass
@vertex fn vsTussockBlade(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  let nb = u32(u.tus2.y);
  let c = tussockCell(ii / nb, u32(u.tus4.x));
  let k = i32(ii % nb);
  let T = tussockAt(c.x, c.y);
  let h0 = hash3f(c.x, c.y, 8000 + k);
  let h1 = hash3f(c.x, c.y, 9000 + k);
  let h2 = hash3f(c.x, c.y, 10000 + k);
  let h3 = hash3f(c.x, c.y, 11000 + k);
  let phi = h0 * 2.0 * PI;
  // 上半球に一様 (cosθ 一様)
  let ct = mix(1.0, 0.1, h1);
  let st = sqrt(1.0 - ct * ct);
  let Bx = tussockBx(T.axis);
  let Bz = cross(T.axis, Bx);
  let radial = Bx * cos(phi) + Bz * sin(phi);
  let p0 = T.center + radial * (T.r * st) + T.axis * (T.a * ct);
  let b = tussockBend(T);
  let y = dot(p0 - T.base, T.axis);
  let center = p0 + b.w * bendDisp(b, y);
  let s0 = normalize(p0 - (T.base + T.axis * u.tusCore.w));
  let axis = normalize(s0 + b.w * (bendSlope(b, y) * dot(s0, T.axis)));
  let a = u.tus2.z * 0.5 * (0.7 + 0.6 * h2);
  let r = u.tus2.w * 0.5 * (0.7 + 0.6 * h3);
  let d = distance(center, u.camPos.xyz);
  let fade = (1.0 - smoothstep(u.tus4.y * 0.6, u.tus4.y, d)) * T.keep;
  let wp = impostorQuad(center, axis, a, r, vi, fade);
  var o: GOut;
  o.pos = u.viewProj * vec4f(wp, 1.0);
  o.wp = wp;
  o.center = center;
  o.axis = axis;
  o.prm = vec4f(a, r, u.geo.w * fade, h0);
  let Vc = normalize(center - u.camPos.xyz);
  let sun = u.sunDir.xyz;
  let n = normalize(radial * (st / T.r) + T.axis * (ct / T.a));
  o.col = u.tusLeaf.rgb * tussockLight(n, sun) * windGain(T.wf, Vc.xz)
        + TRANS_COL * pow(max(dot(Vc, sun), 0.0), 6.0) * 0.15;
  return o;
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
struct BU { dir: vec4f, prm: vec4f }  // prm: 短いぼかしの長さ比, その振幅係数, 平均, -
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
  var acc = vec4f(0.0);
  var wsum = 0.0;
  for (var t = -8; t <= 8; t++) {
    let w = exp(-f32(t*t) * 0.05);
    let ft = f32(t);
    acc += vec4f(
      textureSampleLevel(src, s2, uv + bu.dir.xy * ft, 0.0).r,
      textureSampleLevel(src, s2, uv + bu.dir.zw * ft, 0.0).r,
      textureSampleLevel(src, s2, uv + bu.dir.xy * (ft * bu.prm.x), 0.0).r,
      textureSampleLevel(src, s2, uv + bu.dir.zw * (ft * bu.prm.x), 0.0).r) * w;
    wsum += w;
  }
  let v = acc / wsum;
  let m = bu.prm.z;
  return vec4f(v.xy, m + (v.zw - vec2f(m)) * bu.prm.y);
}
// 等方ガウスぼかし (σ = dir.x texel、平均 dir.z まわりの振幅 × dir.y)。
// rg に同じ値を入れ、方位補間の mix がそのまま通るようにする
@fragment fn fsBlurIso(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let dim = vec2f(textureDimensions(src));
  let uv = fc.xy / dim;
  let s2i = 1.0 / (2.0 * bu.dir.x * bu.dir.x);
  var acc = 0.0;
  var wsum = 0.0;
  for (var j = -4; j <= 4; j++) {
    for (var i = -4; i <= 4; i++) {
      let w = exp(-f32(i*i + j*j) * s2i);
      acc += textureSampleLevel(src, s2, uv + vec2f(f32(i), f32(j)) / dim, 0.0).r * w;
      wsum += w;
    }
  }
  let v = bu.dir.z + (acc / wsum - bu.dir.z) * bu.dir.y;
  return vec4f(v);
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
  // レイヤー i の rg = 方位 (i, i+1) の長いぼかし、ba = 同じ方位の短いぼかし。g は次レイヤーの
  // r と同値の重複だが、サンプリング側の方位補間が 1 fetch になる。密度は 8bit で足りるので
  // rgba8unorm にすればテクセルは rg16float と同じ 4 バイト
  const detailArr = device.createTexture({
    size: [DETAIL_TEX, DETAIL_TEX, NDIR + 1], format: 'rgba8unorm', mipLevelCount: detMipCount,
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
    const blurPipe = mkPipe('fsBlur', 'rgba8unorm');
    const blurIsoPipe = mkPipe('fsBlurIso', 'rgba8unorm');
    const mipPipeR = mkPipe('fsMip', 'r16float');
    const mipPipeRG = mkPipe('fsMip', 'rgba8unorm');
    const enc = device.createCommandEncoder();
    // dir.xy に方位 i、dir.zw に方位 i+1 (i+1 = NDIR は θ=π で、ぼかしの対称性により方位 0 と同じ)
    const blurDirs = (srcTex, dstTex, stepM, span, blurSamp) => {
      for (let dir = 0; dir < NDIR; dir++) {
        const th0 = dir * Math.PI / NDIR;
        const th1 = (dir + 1) * Math.PI / NDIR;
        const bu = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        device.queue.writeBuffer(bu, 0, new Float32Array([
          Math.cos(th0) * stepM / span, Math.sin(th0) * stepM / span,
          Math.cos(th1) * stepM / span, Math.sin(th1) * stepM / span,
          SHORT_RATIO, SHORT_GAIN, detMean, 0,
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
    // 層 NDIR: カメラ足元用の等方タイル
    {
      const bu = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(bu, 0, new Float32Array([ISO_SIGMA, ISO_GAIN, detMean, 0, 0, 0, 0, 0]));
      const bind = device.createBindGroup({
        layout: blurIsoPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: bu } },
          { binding: 1, resource: detailTex.createView({ baseMipLevel: 0, mipLevelCount: 1 }) },
          { binding: 2, resource: sampR },
        ],
      });
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: detailArr.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: NDIR, arrayLayerCount: 1 }),
          loadOp: 'clear', clearValue: [0, 0, 0, 0], storeOp: 'store',
        }],
      });
      pass.setPipeline(blurIsoPipe);
      pass.setBindGroup(0, bind);
      pass.draw(3);
      pass.end();
    }
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
    genMips(detailArr, NDIR + 1, detMipCount, mipPipeRG);
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
  }
  device.popErrorScope().then(e => { if (e) console.error('bake validation:', e.message); });
  const blurMs = performance.now() - t1;
  const wind = createWindTexture(device, WIND);

  // --- scene pipelines (MSAA, canvas直描き) ---
  const sceneMod = device.createShaderModule({ code: SCENE_WGSL });
  const layoutA = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: '2d-array' } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 6, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 7, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, sampler: {} },
    ],
  });
  const uBuf = device.createBuffer({ size: 352, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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
      { binding: 6, resource: wind.tex.createView() },
      { binding: 7, resource: wind.samp },
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
  const tussockPipe = device.createRenderPipeline({
    layout: pLayoutA,
    vertex: { module: sceneMod, entryPoint: 'vsTussock' },
    fragment: { module: sceneMod, entryPoint: 'fsTussock', targets },
    primitive: { topology: 'triangle-list', cullMode: 'none' },
    depthStencil: depthOn,
    multisample: { count: MSAA, alphaToCoverageEnabled: true },
  });
  const tussockBladePipe = device.createRenderPipeline({
    layout: pLayoutA,
    vertex: { module: sceneMod, entryPoint: 'vsTussockBlade' },
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
    detailMode: parseInt(q.get('dmode') || '1', 10),
    windBend: parseFloat(q.get('windBend') || '1.5'), windDark: parseFloat(q.get('windDark') || '0.18'),
    windSpeed: parseFloat(q.get('windSpeed') || '6'), windView: parseFloat(q.get('windView') || '0.6'),
    sunAz: 2.4, sunEl: 0.66, kOpacity: 4.0,
    geomOn: true, bpc: 4, gRadius: 25, gSoft: 0.6, gSigma: 3.0, gDens: 1.0, dither: true,
    gHeight: parseFloat(q.get('gh') || '0.5'), gWidth: parseFloat(q.get('gw') || '0.1'),
    lMin: parseFloat(q.get('lmin') || '1.0'),
    tussockOn: true, tBladesOn: false, tKc: T_P.kc, tKs: T_P.ks,
    time: 0, fps: 0,
  };
  state.pos[1] = terrainHJS(0, 240) + 1.7;
  const camQ = (q.get('cam') || '').split(',').map(Number);
  if (camQ.length === 5 && camQ.every(Number.isFinite)) { state.pos = camQ.slice(0, 3); state.yaw = camQ[3]; state.pitch = camQ[4]; }

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
    if (k === 'i') state.detailMode = (state.detailMode + 1) % 3;
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
    if (k === 'u') state.tussockOn = !state.tussockOn;
    if (k === 'y') state.tBladesOn = !state.tBladesOn;
    if (k === ';') state.tKc = Math.max(0.1, state.tKc / 1.3);
    if (k === "'") state.tKc = Math.min(50, state.tKc * 1.3);
    if (k === 'q') state.tKs = Math.max(0.05, state.tKs / 1.3);
    if (k === 'e') state.tKs = Math.min(20, state.tKs * 1.3);
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
    // rgba8unorm はテクセルあたり 4 値 (r,g,b,a 交互のフラット配列、0..1)、r16float は half が 1 つ
    async readTex(tex, layer, x, y, w) {
      const bpt = tex.format === 'rgba8unorm' ? 4 : 2;
      const buf = device.createBuffer({ size: Math.max(w * bpt, 256), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyTextureToBuffer(
        { texture: tex, origin: [x, y, layer] },
        { buffer: buf, bytesPerRow: Math.max(w * bpt, 256) },
        [w, 1, 1]);
      device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      if (tex.format === 'rgba8unorm') {
        const out = [...new Uint8Array(buf.getMappedRange().slice(0, w * bpt))].map(v => v / 255);
        buf.unmap();
        return out;
      }
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
  const uData = new Float32Array(88);
  const tN = Math.ceil(2 * T_P.R / T_P.cell);
  const tBN = Math.ceil(2 * T_P.br / T_P.cell);

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
    uData.set([state.flatGround ? 1 : 0, state.lMin, state.detailMode, state.windView], 40);
    uData.set([state.gRadius * (1 - state.gSoft), state.gRadius, state.bpc, state.gSigma], 44);
    uData.set([state.gHeight, state.gWidth, state.gDens, state.dither ? 1 : 0], 48);
    uData.set([state.windBend, state.windDark, (state.time * state.windSpeed / wind.tile) % 1, wind.tile], 52);
    uData.set([T_P.r, T_P.h, state.tKc, state.tKs], 56);
    uData.set([T_P.wrap, T_P.nb, T_P.bl, T_P.bw], 60);
    uData.set([tN, T_P.cell, T_P.prob, T_P.R], 64);
    uData.set([tBN, T_P.br, T_P.lmax, T_P.cf], 68);
    uData.set([T_P.k, T_P.debug, T_P.rim0, T_P.iso], 72);
    uData.set([...T_P.leaf, T_P.rimT], 76);
    uData.set([...T_P.core, T_P.org], 80);
    uData.set([T_P.bend, T_P.gf, T_P.cr, T_P.gm], 84);
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
    if (state.tussockOn) {
      pass.setPipeline(tussockPipe);
      pass.draw(T_SEG_C * T_RING_C * 6, tN * tN);
      pass.draw(T_SEG_F * T_RING_F * 6, tBN * tBN, 0, T_LOD_BASE);
      if (state.tBladesOn) {
        pass.setPipeline(tussockBladePipe);
        pass.draw(4, tBN * tBN * T_P.nb);
      }
    }
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

    const detMB = DETAIL_TEX * DETAIL_TEX * (NDIR + 1) * 4 * 4 / 3 / 1048576;
    hud.textContent =
      `fps ${state.fps.toFixed(0)}  density ${densMs.toFixed(0)}ms  blur ${blurMs.toFixed(0)}ms\n` +
      `ndir ${NDIR}  dtex ${DETAIL_TEX}px / dspan ${DETAIL_SPAN}m (${(DETAIL_SPAN / DETAIL_TEX * 100).toFixed(1)}cm/texel)  mem ${detMB.toFixed(1)}MB\n` +
      `bars[B] ${state.barsOn ? 'on' : 'off'}  wind[V] ${state.windOn ? `bend ${state.windBend} dark ${state.windDark} ${state.windSpeed}m/s (${wind.cpuMs.toFixed(0)}ms)` : 'off'}  ` +
      `viewer[T] ${state.rhoOverlay ? 'on' : 'off'}  flat[N] ${state.flatGround ? 'on' : 'off'}  detail[I] ${['long+iso', 'long/short+iso', 'long/short'][state.detailMode]} (short ${SHORT_RATIO} gain ${SHORT_GAIN})\n` +
      `opacity[7/8] ${state.kOpacity.toFixed(1)}  lmin[-/=] ${state.lMin.toFixed(2)}m  sun[1/2] ${(state.sunAz * 180 / Math.PI).toFixed(0)}°\n` +
      `geom[G] ${state.geomOn ? 'on' : 'off'}  blades ${(chunksInfo.blades / 1000).toFixed(0)}k / ${chunksInfo.n} chunks  ` +
      `bpc[3/4] ${state.bpc}  radius[5/6] ${state.gRadius.toFixed(0)}m  soft[,/.] ${state.gSoft.toFixed(2)}  sigma[9/0] ${state.gSigma.toFixed(1)}  dither[X] ${state.dither ? 'on' : 'off'}\n` +
      `height[H/J] ${(state.gHeight * 100).toFixed(0)}cm  width[K/L] ${(state.gWidth * 100).toFixed(1)}cm  shade-dens[[/]] ${state.gDens.toFixed(2)}\n` +
      `tussock[U] ${state.tussockOn ? 'on' : 'off'}  r ${T_P.r}m h ${T_P.h}m cell ${T_P.cell}m prob ${T_P.prob} R ${T_P.R}m  core-k[;/'] ${state.tKc.toFixed(2)} cr ${T_P.cr}  shell-k[Q/E] ${state.tKs.toFixed(2)}  ` +
      `org ${T_P.org}m bend ${T_P.bend} gf ${T_P.gf}m/${T_P.gm}m lmax ${T_P.lmax} rim ${T_P.rim0}/${T_P.rimT} wrap ${T_P.wrap} k ${T_P.k} iso ${T_P.iso}  blades[Y] ${state.tBladesOn ? 'on' : 'off'} ×${T_P.nb} len ${T_P.bl}m w ${T_P.bw}m R ${T_P.br}m\n` +
      `drag:look  WASD:move  R/F:up/down  Shift:fast  P:pause  cam=${state.pos.map(v => v.toFixed(2)).join(',')},${state.yaw.toFixed(3)},${state.pitch.toFixed(3)}`;
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
