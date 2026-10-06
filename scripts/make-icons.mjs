// Draws the PNG icons from public/favicon.svg, the one source: node scripts/make-icons.mjs
// The .ico is then made from two of them with ImageMagick: magick public/favicon-16.png public/favicon-32.png public/favicon.ico
import { readFile, writeFile } from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const svg = await readFile(new URL("../public/favicon.svg", import.meta.url));
// iOS rounds the corners of a home-screen icon itself, so that one is a full square.
const square = Buffer.from(svg.toString().replace(' rx="6.5"', ""));

async function draw(source, size, name) {
  const image = await loadImage(source);
  const canvas = createCanvas(size, size);
  canvas.getContext("2d").drawImage(image, 0, 0, size, size);
  await writeFile(new URL(`../public/${name}`, import.meta.url), await canvas.encode("png"));
}

await draw(svg, 16, "favicon-16.png");
await draw(svg, 32, "favicon-32.png");
await draw(square, 180, "apple-touch-icon.png");
