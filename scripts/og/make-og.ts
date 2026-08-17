/**
 * Generates the link-preview card: public/og.png (1200x630).
 *
 * This asset is necessarily PUBLIC — link crawlers are unauthenticated — so it
 * contains no photograph from the archive. Typography and light only. Publishing
 * a single real frame here would undo the entire point of the project.
 */
import { promises as fs } from 'node:fs';
import sharp from 'sharp';

const W = 1200;
const H = 630;
const EVENT = process.env.FLASHBACK_EVENT_NAME ?? 'QLICK QRAVE';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <defs>
    <radialGradient id="uv" cx="18%" cy="12%" r="62%">
      <stop offset="0%" stop-color="#7A3CFF" stop-opacity="0.42"/>
      <stop offset="100%" stop-color="#7A3CFF" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="siren" cx="88%" cy="92%" r="58%">
      <stop offset="0%" stop-color="#FF2D2D" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="#FF2D2D" stop-opacity="0"/>
    </radialGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="4" stitchTiles="stitch"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
  </defs>

  <rect width="${W}" height="${H}" fill="#080809"/>
  <rect width="${W}" height="${H}" fill="url(#uv)"/>
  <rect width="${W}" height="${H}" fill="url(#siren)"/>
  <rect width="${W}" height="${H}" filter="url(#grain)" opacity="0.15"/>

  <!-- scanlines -->
  <g fill="#000000" opacity="0.20">
    ${Array.from({ length: Math.floor(H / 3) }, (_, i) => `<rect y="${i * 3}" width="${W}" height="1"/>`).join('')}
  </g>

  <!-- kicker -->
  <text x="80" y="196" fill="#A8A29A" font-family="Helvetica Neue, Helvetica, Arial"
    font-size="23" letter-spacing="8.5" font-weight="500">PRIVATE ARCHIVE</text>

  <!-- wordmark, with a chromatic fringe -->
  <g font-family="Impact, Haettenschweiler, Helvetica Neue, Helvetica, Arial" font-size="188"
     letter-spacing="-5" font-weight="700">
    <text x="76" y="352" fill="#2DE1FF" opacity="0.55">FLASHBACK</text>
    <text x="84" y="352" fill="#FF2D2D" opacity="0.45">FLASHBACK</text>
    <text x="80" y="352" fill="#F5F3EE">FLASHBACK</text>
  </g>

  <text x="82" y="424" fill="#E8E5DE" font-family="Helvetica Neue, Helvetica, Arial"
    font-size="46" letter-spacing="2" font-weight="500">${EVENT}</text>

  <rect x="80" y="474" width="120" height="3" fill="#7A3CFF"/>

  <text x="80" y="534" fill="#A8A29A" font-family="Helvetica Neue, Helvetica, Arial"
    font-size="26" letter-spacing="0.4">Photographs from the night. Locked, and built to disappear.</text>

  <text x="80" y="578" fill="#39FF6A" font-family="Helvetica Neue, Helvetica, Arial"
    font-size="19" letter-spacing="4.5" font-weight="500">ACCESS BY INVITATION ONLY</text>
</svg>`;

async function main() {
  // JPEG, not PNG: the film grain makes PNG ~1MB, and link crawlers want a small
  // file. Also stripped of metadata, same as every other derivative here.
  const png = await sharp(Buffer.from(svg))
    .jpeg({ quality: 86, progressive: true, mozjpeg: true })
    .toBuffer();
  await fs.writeFile('public/og.jpg', png);

  const meta = await sharp(png).metadata();
  const stats = await sharp(png).stats();
  const mean = stats.channels.map((c) => c.mean.toFixed(1)).join(', ');
  console.log(`public/og.jpg  ${meta.width}x${meta.height}  ${(png.byteLength / 1024).toFixed(0)}KB`);
  console.log(`channel means: ${mean}  (all ~0 would mean the text failed to render)`);
  if (stats.channels.every((c) => c.mean < 3)) {
    console.error('WARNING: image looks blank — SVG text probably did not render.');
    process.exit(1);
  }
}
main();
