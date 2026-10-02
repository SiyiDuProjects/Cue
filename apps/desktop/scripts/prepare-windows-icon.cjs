// Convert the existing Sage tray artwork into Windows icon resources.
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
app.whenReady().then(() => {
  const root = path.resolve(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
  const data = source.match(/const TRAY_ICON_DATA_URL\s*=\s*"([^"]+)"/)[1];
  const icon = nativeImage.createFromDataURL(data);
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = sizes.map(size => icon.resize({ width: size, height: size, quality: "best" }).toPNG());
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header[entry] = size % 256; header[entry + 1] = size % 256;
    header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  fs.mkdirSync(path.join(root, "assets"), { recursive: true });
  fs.writeFileSync(path.join(root, "assets/sage.ico"), Buffer.concat([header, ...images]));
  app.exit(0);
}).catch(() => app.exit(1));
