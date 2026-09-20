// 突風の足跡テクスチャ。狭帯域の等方ノイズ n の等高線のうち風下 (+x) を向いた側だけを
// 帯として切り抜いて突風の前縁 (弧) とし、風上側へ減衰付き max で引き伸ばして尾を付ける。
// n は整数波数の平面波の和なのでタイルで周期的。帯域を絞るほど山と谷が波長一定で交互に
// 並び、弧の間隔が揃う (Perlin だとスペクトルが広くて等高線が細かく揺れ、山も格子に並ぶ)。
// 帯は (n − level)² + exp(k·∂n/∂x) < thresh の soft 版。∂n/∂x は勾配の RMS で正規化してある。
// テクスチャ空間では風は常に +x 向き。サンプル側で世界座標を風向に回して参照する。
// module ではなく classic script (index.html をファイルとして開くだけで動くようにする)

const WIND = {
  TEX: 512,
  TILE: 200,        // タイル 1 枚が覆う距離 [m]
  wave0: 30,        // ノイズの中心波長 [m]
  band: 0.3,        // 波数の相対帯域幅。|k| ∈ k₀·[1−band, 1+band] から選ぶ
  waves: 30,        // 平面波の本数。少ないと非ガウスになり山の形が揃う
  fold: 1,          // 1 で n を |n| にする。谷も山として数えるので弧が倍になる
  level: 1.0,       // 弧を取る等高線の高さ (n は平均 0、標準偏差 1)
  gradK: 2.0,       // exp(k·∂n/∂x) の k。大きいほど風下を向いた側だけに絞る
  thresh: 0.5,      // (n − level)² + exp(k·∂n/∂x) < thresh
  soft: 0.5,        // 帯の縁の柔らかさ (thresh と同じ単位)
  tail: 20,         // 尾の減衰長 [m]
  detailScale: 3,   // 足す細かいノイズの波長 = wave0 / detailScale
  detailAmp: 0.75,  // 細かいノイズの振幅 (弧の高さ 1 に対するピーク比)
  spread: 0.5,      // 1 texel 伝播ごとの横ぼかし σ [m]。距離 L の尾で σ ≈ spread·√(L/texel)
  seed: 1,
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const smoothstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

function quantile(arr, q) {
  const s = Float32Array.from(arr).sort()
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]
}

// 周期 period の格子で繰り返す勾配ノイズ。弧を作るには帯域が広すぎるが、細かい重ねには
// 平面波の和 (512² × 60 本で 600ms) より 1 桁速い
function makeGradNoise(rand) {
  const N = 256
  const perm = new Uint16Array(N * 2)
  for (let i = 0; i < N; i++) perm[i] = i
  for (let i = N - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const t = perm[i]; perm[i] = perm[j]; perm[j] = t
  }
  for (let i = 0; i < N; i++) perm[N + i] = perm[i]
  const gx = new Float32Array(N), gy = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const a = rand() * Math.PI * 2
    gx[i] = Math.cos(a); gy[i] = Math.sin(a)
  }
  const fade = t => t * t * t * (t * (t * 6 - 15) + 10)
  return (x, y, period) => {
    const xi = Math.floor(x), yi = Math.floor(y)
    const fx = x - xi, fy = y - yi
    const x0 = ((xi % period) + period) % period, x1 = (x0 + 1) % period
    const y0 = ((yi % period) + period) % period, y1 = (y0 + 1) % period
    const g = (ix, iy, dx, dy) => {
      const h = perm[perm[ix & 255] + (iy & 255)]
      return gx[h] * dx + gy[h] * dy
    }
    const u = fade(fx), v = fade(fy)
    const a = g(x0, y0, fx, fy), b = g(x1, y0, fx - 1, fy)
    const c = g(x0, y1, fx, fy - 1), d = g(x1, y1, fx - 1, fy - 1)
    const lo = a + (b - a) * u
    return lo + (c + (d - c) * u - lo) * v
  }
}

function normalize(n) {
  let mean = 0
  for (const v of n) mean += v
  mean /= n.length
  let sd = 0
  for (const v of n) sd += (v - mean) ** 2
  sd = Math.sqrt(sd / n.length) || 1
  for (let k = 0; k < n.length; k++) n[k] = (n[k] - mean) / sd
  return n
}

// 波長がタイルの 1/period の 2 オクターブ勾配ノイズ。平均 0・標準偏差 1 に正規化
function perlinNoise(TEX, period, rand) {
  const noise = makeGradNoise(rand)
  const per = Math.max(1, Math.round(period))
  const n = new Float32Array(TEX * TEX)
  for (let j = 0; j < TEX; j++) {
    for (let i = 0; i < TEX; i++) {
      const x = (i + 0.5) / TEX, y = (j + 0.5) / TEX
      n[j * TEX + i] = noise(x * per, y * per, per) + 0.5 * noise(x * per * 2, y * per * 2, per * 2)
    }
  }
  return normalize(n)
}

// 環 |k| ∈ k₀·[1±band] に入る整数波数から waves 本を引いた平面波の和。平均 0・標準偏差 1 に正規化
function bandNoise(TEX, k0, band, waves, rand) {
  const ring = []
  const kmax = Math.ceil(k0 * (1 + band))
  for (let ky = -kmax; ky <= kmax; ky++) {
    for (let kx = 1; kx <= kmax; kx++) {
      const kr = Math.hypot(kx, ky)
      if (kr >= k0 * (1 - band) && kr <= k0 * (1 + band)) ring.push([kx, ky])
    }
  }
  const picked = []
  for (let m = 0; m < waves && ring.length; m++) picked.push(...ring.splice(Math.floor(rand() * ring.length), 1))
  const ws = picked.map(([kx, ky]) => [2 * Math.PI * kx / TEX, 2 * Math.PI * ky / TEX, rand() * 2 * Math.PI])
  const n = new Float32Array(TEX * TEX)
  for (let j = 0; j < TEX; j++) {
    for (let i = 0; i < TEX; i++) {
      let sum = 0
      for (const [kx, ky, ph] of ws) sum += Math.sin(kx * i + ky * j + ph)
      n[j * TEX + i] = sum
    }
  }
  return normalize(n)
}

// 戻り値 rg: [gust, noise 表示用] を texel ごとに詰めた Float32Array (0..1)
function genWindField(p = WIND) {
  const { TEX, TILE } = p
  const texel = TILE / TEX
  const rand = mulberry32(p.seed)
  const n = bandNoise(TEX, TILE / p.wave0, p.band, p.waves, rand)
  if (p.fold > 0.5) for (let k = 0; k < n.length; k++) n[k] = Math.abs(n[k])

  const nx = new Float32Array(TEX * TEX)
  let g2 = 0
  for (let j = 0; j < TEX; j++) {
    for (let i = 0; i < TEX; i++) {
      const dx = (n[j * TEX + (i + 1) % TEX] - n[j * TEX + (i - 1 + TEX) % TEX]) / 2
      const dy = (n[((j + 1) % TEX) * TEX + i] - n[((j - 1 + TEX) % TEX) * TEX + i]) / 2
      nx[j * TEX + i] = dx
      g2 += dx * dx + dy * dy
    }
  }
  const grms = Math.sqrt(g2 / (TEX * TEX))
  const g = new Float32Array(TEX * TEX)
  for (let k = 0; k < g.length; k++) {
    const e = (n[k] - p.level) ** 2 + Math.exp(p.gradK * nx[k] / grms)
    g[k] = smoothstep(p.thresh, p.thresh - p.soft, e)
  }

  // 風下 (右) の列から風上へ 1 列ずつ伝播する。各段で減衰させた上に小さな横ぼかしを
  // 掛けるので、尾は風上へ行くほど横に広がる (拡散型)。帯の中は g が勝つので前縁は鋭いまま。
  // 周期境界のため 2 周して 2 周目だけ書く
  const wake = new Float32Array(TEX * TEX)
  const decay = Math.exp(-texel / p.tail)
  const sig = p.spread / texel
  const K = [], R = Math.max(1, Math.ceil(sig * 3))
  for (let k = -R; k <= R; k++) K.push(Math.exp(-k * k / (2 * sig * sig)))
  const ksum = K.reduce((a, b) => a + b, 0)
  let prev = new Float32Array(TEX), cur = new Float32Array(TEX)
  for (let lap = 0; lap < 2; lap++) {
    for (let i = TEX - 1; i >= 0; i--) {
      for (let j = 0; j < TEX; j++) {
        let b = 0
        for (let k = -R; k <= R; k++) b += prev[(((j + k) % TEX) + TEX) % TEX] * K[k + R]
        cur[j] = Math.max(g[j * TEX + i], b / ksum * decay)
      }
      if (lap === 1) for (let j = 0; j < TEX; j++) wake[j * TEX + i] = cur[j]
      const t = prev; prev = cur; cur = t
    }
  }

  // 弧より細かい等方ノイズを弱く重ねる
  const detail = perlinNoise(TEX, TILE / p.wave0 * p.detailScale, rand)
  const out = new Float32Array(TEX * TEX * 2)
  for (let k = 0; k < wake.length; k++) {
    out[k * 2] = Math.min(1, Math.max(0, wake[k] + p.detailAmp * detail[k] / 3))
    out[k * 2 + 1] = Math.min(1, Math.max(0, 0.5 + n[k] * 0.2))
  }
  return { rg: out, size: TEX, texel }
}

// rg8unorm + ミップ。ミップが無いと遠方で突風の縁がちらつく
function createWindTexture(device, p = WIND) {
  const t0 = performance.now()
  const f = genWindField(p)
  const levels = []
  let n = f.size
  const base = new Uint8Array(n * n * 2)
  for (let i = 0; i < base.length; i++) base[i] = Math.round(f.rg[i] * 255)
  levels.push(base)
  while (n > 1) {
    const src = levels[levels.length - 1], w = n
    n /= 2
    const dst = new Uint8Array(n * n * 2)
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        for (let ch = 0; ch < 2; ch++) {
          const at = (x, y) => src[(y * w + x) * 2 + ch]
          dst[(j * n + i) * 2 + ch] = Math.round((at(2 * i, 2 * j) + at(2 * i + 1, 2 * j) + at(2 * i, 2 * j + 1) + at(2 * i + 1, 2 * j + 1)) / 4)
        }
      }
    }
    levels.push(dst)
  }
  const tex = device.createTexture({
    size: [f.size, f.size], format: 'rg8unorm', mipLevelCount: levels.length,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  levels.forEach((data, mipLevel) => {
    const m = f.size >> mipLevel
    device.queue.writeTexture({ texture: tex, mipLevel }, data, { bytesPerRow: m * 2, rowsPerImage: m }, [m, m, 1])
  })
  const samp = device.createSampler({
    magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear',
    addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8,
  })
  return { tex, samp, tile: p.TILE, cpuMs: performance.now() - t0 }
}
