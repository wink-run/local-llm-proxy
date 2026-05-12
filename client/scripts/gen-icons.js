const { PNG } = require('pngjs');
const { Resvg } = require('@resvg/resvg-js');
const png2icons = require('png2icons');
const fs = require('fs');
const path = require('path');

function makeCirclePNG(r, g, b, size = 16) {
  const png = new PNG({ width: size, height: size, filterType: -1 });
  const cx = size / 2, cy = size / 2, radius = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (size * y + x) * 4;
      const dist = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
      if (dist <= radius) {
        png.data[idx] = r; png.data[idx + 1] = g; png.data[idx + 2] = b; png.data[idx + 3] = 255;
      } else {
        png.data[idx] = png.data[idx + 1] = png.data[idx + 2] = png.data[idx + 3] = 0;
      }
    }
  }
  return PNG.sync.write(png);
}

const assetsDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assetsDir, { recursive: true });
fs.writeFileSync(path.join(assetsDir, 'tray-green.png'), makeCirclePNG(34, 197, 94));
fs.writeFileSync(path.join(assetsDir, 'tray-gray.png'), makeCirclePNG(107, 114, 128));
console.log('Tray icons generated in assets/');

// ── App icons from SVG logo ───────────────────────────────────────────────────

const svgPath = path.join(__dirname, '..', 'src', 'assets', 'logo.svg');
const svgContent = fs.readFileSync(svgPath, 'utf-8');

const resvg = new Resvg(svgContent, { fitTo: { mode: 'width', value: 1024 } });
const pngBuffer = Buffer.from(resvg.render().asPng());

const buildDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(buildDir, { recursive: true });

fs.writeFileSync(path.join(buildDir, 'icon.png'), pngBuffer);
console.log('App icon PNG generated (1024×1024)');

const icns = png2icons.createICNS(pngBuffer, png2icons.BILINEAR, 0);
if (icns) { fs.writeFileSync(path.join(buildDir, 'icon.icns'), icns); console.log('icon.icns generated'); }
else console.warn('Warning: ICNS generation failed');

const ico = png2icons.createICO(pngBuffer, png2icons.BILINEAR, 0, true);
if (ico) { fs.writeFileSync(path.join(buildDir, 'icon.ico'), ico); console.log('icon.ico generated'); }
else console.warn('Warning: ICO generation failed');
