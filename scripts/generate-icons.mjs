#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";

const root = process.cwd();
const sourceIcon = join(root, "assets/icon.png");
const macAssets = join(root, "apps/macos/ForgeAgentMac/Assets");
const iconset = join(macAssets, "AppIcon.iconset");
const transparentSource = join("/tmp", "deepseek-forge-icon-transparent.png");

const darkEdgeThreshold = 170;

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function resizePng(input, output, size) {
  ensureDir(dirname(output));
  execFileSync("sips", ["-z", String(size), String(size), input, "--out", output], { stdio: "ignore" });
}

function writePngIcns(outputPath, entries) {
  const payloads = entries.map(([type, file]) => {
    const data = readFileSync(file);
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, "ascii");
    header.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([header, data]);
  });
  const totalLength = 8 + payloads.reduce((sum, payload) => sum + payload.length, 0);
  const header = Buffer.alloc(8);
  header.write("icns", 0, 4, "ascii");
  header.writeUInt32BE(totalLength, 4);
  writeFileSync(outputPath, Buffer.concat([header, ...payloads], totalLength));
}

function writeIcns(iconsetPath, outputPath) {
  try {
    execFileSync("iconutil", ["-c", "icns", iconsetPath, "-o", outputPath], { stdio: "inherit" });
    return;
  } catch (err) {
    console.warn("iconutil rejected the iconset; writing PNG-based ICNS directly.");
  }
  writePngIcns(outputPath, [
    ["icp4", join(iconsetPath, "icon_16x16.png")],
    ["icp5", join(iconsetPath, "icon_16x16@2x.png")],
    ["icp6", join(iconsetPath, "icon_32x32@2x.png")],
    ["ic07", join(iconsetPath, "icon_128x128.png")],
    ["ic08", join(iconsetPath, "icon_128x128@2x.png")],
    ["ic09", join(iconsetPath, "icon_256x256@2x.png")],
    ["ic10", join(iconsetPath, "icon_512x512@2x.png")],
  ]);
}

function edgeTransparentPng(inputPath, outputPath) {
  const png = PNG.sync.read(readFileSync(inputPath));
  const { width, height, data } = png;
  const visited = new Uint8Array(width * height);
  const queue = [];

  const isExternalDark = (x, y) => {
    const offset = (y * width + x) * 4;
    const r = data[offset] ?? 0;
    const g = data[offset + 1] ?? 0;
    const b = data[offset + 2] ?? 0;
    return r <= darkEdgeThreshold && g <= darkEdgeThreshold && b <= darkEdgeThreshold;
  };

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (visited[index]) return;
    if (!isExternalDark(x, y)) return;
    visited[index] = 1;
    queue.push(index);
  };

  for (let x = 0; x < width; x += 1) {
    push(x, 0);
    push(x, height - 1);
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y);
    push(width - 1, y);
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor];
    const x = index % width;
    const y = Math.floor(index / width);
    push(x + 1, y);
    push(x - 1, y);
    push(x, y + 1);
    push(x, y - 1);
  }

  for (let index = 0; index < visited.length; index += 1) {
    if (!visited[index]) continue;
    const offset = index * 4;
    data[offset + 3] = 0;
  }

  writeFileSync(outputPath, PNG.sync.write(png));
}

function main() {
  if (!existsSync(sourceIcon)) {
    throw new Error(`Missing source icon: ${sourceIcon}`);
  }

  edgeTransparentPng(sourceIcon, transparentSource);
  writeFileSync(sourceIcon, readFileSync(transparentSource));

  ensureDir(macAssets);
  rmSync(iconset, { recursive: true, force: true });
  ensureDir(iconset);

  resizePng(transparentSource, join(macAssets, "AppIcon.png"), 1024);

  const macSizes = [
    ["icon_16x16.png", 16],
    ["icon_16x16@2x.png", 32],
    ["icon_32x32.png", 32],
    ["icon_32x32@2x.png", 64],
    ["icon_128x128.png", 128],
    ["icon_128x128@2x.png", 256],
    ["icon_256x256.png", 256],
    ["icon_256x256@2x.png", 512],
    ["icon_512x512.png", 512],
    ["icon_512x512@2x.png", 1024],
  ];
  for (const [name, size] of macSizes) {
    resizePng(transparentSource, join(iconset, name), size);
  }

  writeIcns(iconset, join(macAssets, "AppIcon.icns"));

  resizePng(transparentSource, join(root, "web/public/icon.png"), 512);
  resizePng(transparentSource, join(root, "apps/android/ForgeAgentAndroid/app/src/main/res/drawable-nodpi/deepseek_forge_icon.png"), 512);
  resizePng(transparentSource, join(root, "apps/android/ForgeAgentAndroid/app/src/main/res/mipmap-nodpi/deepseek_forge_icon.png"), 512);

  const chromeIconDir = join(root, "plugins/forgewebridge/chrome-extension/icons");
  for (const size of [16, 32, 48, 128]) {
    resizePng(transparentSource, join(chromeIconDir, `icon${size}.png`), size);
  }

  console.log("Generated DeepSeek-Forge icons without the external black background.");
}

main();
