'use strict';
const sharp = require('sharp');
const { default: pngToIco } = require('png-to-ico');
const fs = require('fs');
const path = require('path');

const svgPath = path.join(__dirname, 'icon.svg');
const icoPath = path.join(__dirname, 'icon.ico');
const sizes = [16, 32, 48, 64, 128, 256];

async function main() {
  const svgBuffer = fs.readFileSync(svgPath);
  const pngBuffers = await Promise.all(
    sizes.map(size =>
      sharp(svgBuffer)
        .resize(size, size)
        .png()
        .toBuffer()
    )
  );

  const icoBuffer = await pngToIco(pngBuffers);
  fs.writeFileSync(icoPath, icoBuffer);
  console.log(`icon.ico created (${(icoBuffer.length / 1024).toFixed(1)} KB) with sizes: ${sizes.join(', ')}px`);
}

main().catch(err => { console.error(err); process.exit(1); });
