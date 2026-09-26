#!/usr/bin/env node

// 生成 omp 官方图标的全套应用图标资产（源几何 = oh-my-pi 仓库 assets/icon.svg 的 π 符号，
// 拷贝存档于 build/omp-icon.svg）。零依赖：纯 JS 光栅化（3x 超采样）+ 手写 PNG/ICO/ICNS 封装。
//
// 覆盖资产位（与旧 ZCode 图标完全同一组文件名，运行时代码零改动）：
//   packages/desktop/build/icon.{png,ico,icns}、icon_windows.png、icon_installer.{png,ico,icns}
//   packages/desktop/build/icons/<N>x<N>.png（Linux 各尺寸）
//   packages/web/public/favicon.ico
//   public/icon_512@2x.png、public/logo/icons/*（README 用副本）

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

// ── omp 品牌几何（icon.svg 的 120x90 viewBox，最后坐标为圆角半径）──
const GLYPH_W = 120;
const GLYPH_H = 90;
const BACKGROUND = [13, 13, 13]; // #0d0d0d
const LIGHT = [250, 250, 250]; // #fafafa
const ORANGE = [249, 115, 22]; // #f97316
const GLYPH_LAYERS = [
  { kind: "rect", x: 10, y: 8, w: 100, h: 12, r: 2, color: LIGHT, alpha: 1 },
  { kind: "rect", x: 25, y: 20, w: 12, h: 62, r: 2, color: LIGHT, alpha: 1 },
  { kind: "rect", x: 75, y: 20, w: 12, h: 45, r: 2, color: LIGHT, alpha: 1 },
  { kind: "rect", x: 71, y: 55, w: 20, h: 16, r: 3, color: ORANGE, alpha: 1 },
  { kind: "rect", x: 76, y: 59, w: 3, h: 8, r: 1, color: BACKGROUND, alpha: 1 },
  { kind: "rect", x: 82, y: 59, w: 3, h: 8, r: 1, color: BACKGROUND, alpha: 1 },
  { kind: "circle", cx: 18, cy: 14, r: 2, color: ORANGE, alpha: 0.8 },
  { kind: "circle", cx: 102, cy: 14, r: 2, color: ORANGE, alpha: 0.8 },
];

function insideRoundedRect(px, py, shape) {
  const { x, y, w, h, r } = shape;
  if (px < x || px > x + w || py < y || py > y + h) return false;
  const rx = Math.min(r, w / 2);
  const ry = Math.min(r, h / 2);
  const nearLeft = px < x + rx;
  const nearRight = px > x + w - rx;
  const nearTop = py < y + ry;
  const nearBottom = py > y + h - ry;
  const corner =
    (nearLeft || nearRight) &&
    (nearTop || nearBottom) &&
    !(nearLeft && nearRight) &&
    !(nearTop && nearBottom);
  if (!corner) return true;
  const cxCorner = nearLeft ? x + rx : x + w - rx;
  const cyCorner = nearTop ? y + ry : y + h - ry;
  const dx = (px - cxCorner) / rx;
  const dy = (py - cyCorner) / ry;
  return dx * dx + dy * dy <= 1;
}

function insideCircle(px, py, shape) {
  const dx = px - shape.cx;
  const dy = py - shape.cy;
  return dx * dx + dy * dy <= shape.r * shape.r;
}

/** 渲染 size×size 图标：深色圆角底 + 居中 π 字形（glyph 宽占 74%，含 13% 边距）。 */
function renderIcon(size) {
  const pixels = new Uint8ClampedArray(size * size * 4);
  const glyphWidth = size * 0.74;
  const scale = glyphWidth / GLYPH_W;
  const glyphHeight = GLYPH_H * scale;
  const offsetX = (size - glyphWidth) / 2;
  const offsetY = (size - glyphHeight) / 2;
  const bgRadius = size * 0.18;
  const ss = 3; // 每轴超采样倍数
  const sampleStep = 1 / ss;
  const bgShape = { x: 0, y: 0, w: size, h: size, r: bgRadius };
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let alpha = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const sampleX = px + (sx + 0.5) * sampleStep;
          const sampleY = py + (sy + 0.5) * sampleStep;
          let color = null;
          let coverage = 0;
          if (insideRoundedRect(sampleX, sampleY, bgShape)) {
            color = BACKGROUND;
            coverage = 1;
            const gx = (sampleX - offsetX) / scale;
            const gy = (sampleY - offsetY) / scale;
            for (const layer of GLYPH_LAYERS) {
              const hit =
                layer.kind === "circle"
                  ? insideCircle(gx, gy, layer)
                  : insideRoundedRect(gx, gy, layer);
              if (hit) {
                color = blend(layer.color, layer.alpha, color);
              }
            }
          }
          if (color) {
            red += color[0] * coverage;
            green += color[1] * coverage;
            blue += color[2] * coverage;
            alpha += 255 * coverage;
          }
        }
      }
      const sampleCount = ss * ss;
      const index = (py * size + px) * 4;
      pixels[index] = red / sampleCount;
      pixels[index + 1] = green / sampleCount;
      pixels[index + 2] = blue / sampleCount;
      pixels[index + 3] = alpha / sampleCount;
    }
  }
  return pixels;
}

function blend(source, alpha, base) {
  return [
    Math.round(source[0] * alpha + base[0] * (1 - alpha)),
    Math.round(source[1] * alpha + base[1] * (1 - alpha)),
    Math.round(source[2] * alpha + base[2] * (1 - alpha)),
  ];
}

// ── PNG 编码（filter 0 + zlib）──
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let row = 0; row < size; row += 1) {
    raw[row * (size * 4 + 1)] = 0; // filter none
    Buffer.from(pixels.buffer, row * size * 4, size * 4).copy(raw, row * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── ICO（PNG 载荷，Vista+）与 ICNS（PNG 载荷类型码）──
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon
  header.writeUInt16LE(entries.length, 4);
  const dirSize = 6 + entries.length * 16;
  const dirEntries = [];
  const blobs = [];
  let offset = dirSize;
  for (const [size, png] of entries) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0;
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bpp
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    dirEntries.push(entry);
    blobs.push(png);
    offset += png.length;
  }
  return Buffer.concat([header, ...dirEntries, ...blobs]);
}

const ICNS_TYPES = {
  16: "icp4",
  32: "ic11",
  64: "ic12",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
};

function encodeIcns(entries) {
  const chunks = [];
  for (const [size, png] of entries) {
    const type = Buffer.from(ICNS_TYPES[size] ?? "ic10", "ascii");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(png.length + 8);
    chunks.push(Buffer.concat([type, length, png]));
  }
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0) + 8;
  const header = Buffer.alloc(8);
  header.write("icns", 0, "ascii");
  header.writeUInt32BE(totalLength, 4);
  return Buffer.concat([header, ...chunks]);
}

// ── 生成全部资产 ──
const renderCache = new Map();
function pngOf(size) {
  if (!renderCache.has(size)) {
    renderCache.set(size, encodePng(size, renderIcon(size)));
  }
  return renderCache.get(size);
}

const buildDir = resolve(desktopRoot, "build");
const linuxIconsDir = resolve(buildDir, "icons");
mkdirSync(linuxIconsDir, { recursive: true });

for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  writeFileSync(resolve(linuxIconsDir, `${size}x${size}.png`), pngOf(size));
}
writeFileSync(resolve(buildDir, "icon.png"), pngOf(1024));
writeFileSync(resolve(buildDir, "icon_windows.png"), pngOf(1024));
writeFileSync(resolve(buildDir, "icon_installer.png"), pngOf(1024));
writeFileSync(
  resolve(buildDir, "icon.ico"),
  encodeIco([16, 32, 48, 64, 256].map((size) => [size, pngOf(size)])),
);
writeFileSync(
  resolve(buildDir, "icon_installer.ico"),
  encodeIco([16, 32, 48, 64, 256].map((size) => [size, pngOf(size)])),
);
writeFileSync(
  resolve(buildDir, "icon.icns"),
  encodeIcns([16, 32, 128, 256, 512, 1024].map((size) => [size, pngOf(size)])),
);
writeFileSync(
  resolve(buildDir, "icon_installer.icns"),
  encodeIcns([128, 256, 512, 1024].map((size) => [size, pngOf(size)])),
);

// Web favicon 与 README 公共副本
writeFileSync(
  resolve(repoRoot, "packages", "web", "public", "favicon.ico"),
  encodeIco([16, 24, 32, 48, 64, 128, 256].map((size) => [size, pngOf(size)])),
);
writeFileSync(resolve(repoRoot, "public", "icon_512@2x.png"), pngOf(1024));
const publicIconsDir = resolve(repoRoot, "public", "logo", "icons");
mkdirSync(publicIconsDir, { recursive: true });
for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  copyFileSync(
    resolve(linuxIconsDir, `${size}x${size}.png`),
    resolve(publicIconsDir, `${size}x${size}.png`),
  );
}
copyFileSync(resolve(buildDir, "icon.ico"), resolve(publicIconsDir, "icon.ico"));
copyFileSync(resolve(buildDir, "icon.icns"), resolve(publicIconsDir, "icon.icns"));

// 源 SVG 存档（几何来源：jchanghong023/oh-my-pi assets/icon.svg；内嵌以摆脱对兄弟检出的依赖）
const OMP_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 90" width="120" height="90">
  <!-- Pi symbol with plugin connector -->
  <rect x="10" y="8" width="100" height="12" rx="2" fill="#fafafa"/>
  <rect x="25" y="20" width="12" height="62" rx="2" fill="#fafafa"/>
  <rect x="75" y="20" width="12" height="45" rx="2" fill="#fafafa"/>
  <rect x="71" y="55" width="20" height="16" rx="3" fill="#f97316"/>
  <rect x="76" y="59" width="3" height="8" rx="1" fill="#0d0d0d"/>
  <rect x="82" y="59" width="3" height="8" rx="1" fill="#0d0d0d"/>
  <circle cx="18" cy="14" r="2" fill="#f97316" opacity="0.8"/>
  <circle cx="102" cy="14" r="2" fill="#f97316" opacity="0.8"/>
</svg>
`;
writeFileSync(resolve(buildDir, "omp-icon.svg"), OMP_ICON_SVG, "utf8");

console.log("[generate-omp-icons] 图标资产已生成（build/、web favicon、public/logo）");
