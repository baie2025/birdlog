// 自测用：在浏览器里现画一批「照片」，带上拍摄时间、相机参数和位置，用来走一遍导入流程。
// 用法（浏览器控制台）：const { makeFixtures } = await import('/test/fixtures.js'); __birdlog.addFiles(await makeFixtures());

import { buildTiff, sampleTags, insertExif, fakeTiffRaw, fakeCr3 } from './synth.js';

async function drawJpeg(label, hue, w = 3000, h = 2000) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${(hue + 150) % 360} 35% 78%)`);
  bg.addColorStop(1, `hsl(${(hue + 190) % 360} 30% 52%)`);
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  // 一只示意的鸟：身体、头、喙、尾、眼
  const cx = w / 2, cy = h / 2, s = Math.min(w, h) / 4;
  g.fillStyle = `hsl(${hue} 70% 45%)`;
  g.beginPath(); g.ellipse(cx, cy, s * 1.25, s * 0.85, -0.25, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(cx + s * 1.05, cy - s * 0.7, s * 0.52, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(cx - s * 1.0, cy + s * 0.2); g.lineTo(cx - s * 2.1, cy + s * 0.75); g.lineTo(cx - s * 1.0, cy + s * 0.65); g.fill();
  g.fillStyle = `hsl(${(hue + 40) % 360} 85% 55%)`;
  g.beginPath(); g.moveTo(cx + s * 1.5, cy - s * 0.8); g.lineTo(cx + s * 2.05, cy - s * 0.62); g.lineTo(cx + s * 1.5, cy - s * 0.5); g.fill();
  g.fillStyle = '#111';
  g.beginPath(); g.arc(cx + s * 1.2, cy - s * 0.8, s * 0.07, 0, Math.PI * 2); g.fill();
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.font = `600 ${Math.round(h / 14)}px system-ui, sans-serif`;
  g.fillText(label, w * 0.04, h * 0.94);
  const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return new Uint8Array(await blob.arrayBuffer());
}

const BOLSA = { lat: 33.69611, lng: -118.04639 };   // Bolsa Chica
const CENTRAL = { lat: 40.77737, lng: -73.96903 };  // Central Park

export async function makeFixtures() {
  const files = [];
  const jpeg = async (name, label, hue, t, gps, opts = {}) => {
    const img = await drawJpeg(label, hue, opts.w, opts.h);
    const tags = sampleTags({ t, ...(gps || {}), ...opts.tags });
    const bytes = insertExif(img, buildTiff(tags));
    files.push(new File([bytes], name, { type: 'image/jpeg', lastModified: Date.parse('2026-11-15T10:00:00') }));
    return bytes;
  };
  // 第一天：Bolsa Chica，手机拍的带位置
  const first = await jpeg('IMG_1001.JPG', 'snowy egret', 200, '2026:11:14 07:42:10', BOLSA);
  await jpeg('IMG_1002.JPG', 'snowy egret 2', 205, '2026:11:14 07:43:02', BOLSA);
  await jpeg('IMG_1003.JPG', 'brown pelican', 30, '2026:11:14 08:15:40', BOLSA);
  await jpeg('IMG_1004.JPG', 'marbled godwit', 20, '2026:11:14 08:31:09', BOLSA);
  // 第二天：相机拍的，没有位置
  await jpeg('DSC_2001.JPG', 'northern cardinal', 0, '2026:10:03 16:20:00', null, { tags: { make: 'NIKON CORPORATION', model: 'NIKON Z 8', lens: 'NIKKOR Z 180-600mm f/5.6-6.3 VR' } });
  await jpeg('DSC_2002.JPG', 'blue jay', 220, '2026:10:03 16:28:41', null, { tags: { make: 'NIKON CORPORATION', model: 'NIKON Z 8', lens: 'NIKKOR Z 180-600mm f/5.6-6.3 VR' } });
  await jpeg('DSC_2003.JPG', 'red-tailed hawk', 15, '2026:10:03 17:02:13', null, { tags: { make: 'NIKON CORPORATION', model: 'NIKON Z 8', lens: 'NIKKOR Z 180-600mm f/5.6-6.3 VR' } });
  // 去年的，竖构图
  await jpeg('P5120033.JPG', 'yellow warbler', 55, '2025:05:12 06:55:30', CENTRAL, { w: 2000, h: 3000 });
  // 和第一张完全相同的重复文件
  files.push(new File([first], 'IMG_1001 (copy).JPG', { type: 'image/jpeg' }));
  // 没有任何拍摄信息的 PNG
  {
    const c = new OffscreenCanvas(1600, 1200);
    const g = c.getContext('2d');
    g.fillStyle = '#7d9c8a'; g.fillRect(0, 0, 1600, 1200);
    g.fillStyle = '#fff'; g.font = '600 90px system-ui'; g.fillText('PNG no exif', 80, 1100);
    const blob = await c.convertToBlob({ type: 'image/png' });
    files.push(new File([blob], 'export-no-exif.png', { type: 'image/png', lastModified: Date.parse('2026-09-20T09:30:00') }));
  }
  // 假 RAW：TIFF 系（像 NEF），内嵌预览自己不带方向信息，RAW 里记的方向是「需要顺时针转 90 度」
  {
    const inner = await drawJpeg('RAW preview (rotated)', 280, 3000, 2000);
    const raw = fakeTiffRaw(inner, sampleTags({ t: '2026:11:14 09:05:00', orientation: 6, make: 'SONY', model: 'ILCE-1', lens: 'FE 200-600mm F5.6-6.3 G OSS' }));
    files.push(new File([raw], 'DSC09001.ARW', { type: '' }));
  }
  // 假 CR3
  {
    const inner = await drawJpeg('CR3 preview', 330, 3000, 2000);
    const raw = fakeCr3(inner, sampleTags({ t: '2026:10:03 17:30:00', ...CENTRAL }));
    files.push(new File([raw], 'IMG_0042.CR3', { type: '' }));
  }
  // 不是图片的文件
  files.push(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
  return files;
}
