import zlib from 'node:zlib';

import type { IActivitySplit } from '../models/activity.model.js';
import { decodePolyline, type RouteCoordinate } from './polyline.js';

export const ROUTE_THUMBNAIL_WIDTH = 640;
export const ROUTE_THUMBNAIL_HEIGHT = 360;

interface PixelPoint {
  x: number;
  y: number;
}

interface Colour {
  r: number;
  g: number;
  b: number;
  a: number;
}

const BACKGROUND: Colour = { r: 11, g: 15, b: 14, a: 255 };
const GRID: Colour = { r: 28, g: 36, b: 33, a: 255 };
const ROUTE_SHADOW: Colour = { r: 2, g: 4, b: 4, a: 205 };
const VOLT: Colour = { r: 198, g: 255, b: 61, a: 255 };
const END: Colour = { r: 247, g: 249, b: 248, a: 255 };

/** A deterministic, no-network PNG used by activity lists and share sheets. */
export function renderRouteThumbnail(
  encodedPolyline: string,
  splits: ReadonlyArray<IActivitySplit> = [],
): Buffer | null {
  const route = decodePolyline(encodedPolyline);
  if (route.length === 0) return null;

  const pixels = Buffer.alloc(
    ROUTE_THUMBNAIL_WIDTH * ROUTE_THUMBNAIL_HEIGHT * 4,
  );
  fill(pixels, BACKGROUND);
  drawGrid(pixels);

  const projected = projectToCanvas(route);
  drawRoute(pixels, projected, ROUTE_SHADOW, 5);
  drawRoute(pixels, projected, VOLT, 2);

  const splitCoordinates = locateSplitCoordinates(route, splits);
  const splitPixels = projectKnownCoordinates(route, splitCoordinates);
  for (const point of splitPixels) {
    drawCircle(pixels, point, 5, BACKGROUND);
    drawRing(pixels, point, 5, 2, VOLT);
  }

  const start = projected[0];
  const end = projected[projected.length - 1];
  if (start) {
    drawCircle(pixels, start, 8, ROUTE_SHADOW);
    drawCircle(pixels, start, 5, VOLT);
  }
  if (end) {
    drawCircle(pixels, end, 8, ROUTE_SHADOW);
    drawCircle(pixels, end, 5, END);
  }

  return encodePng(pixels, ROUTE_THUMBNAIL_WIDTH, ROUTE_THUMBNAIL_HEIGHT);
}

function fill(pixels: Buffer, colour: Colour): void {
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = colour.r;
    pixels[i + 1] = colour.g;
    pixels[i + 2] = colour.b;
    pixels[i + 3] = colour.a;
  }
}

function drawGrid(pixels: Buffer): void {
  for (let x = 32; x < ROUTE_THUMBNAIL_WIDTH; x += 64) {
    drawLine(
      pixels,
      { x, y: 0 },
      { x, y: ROUTE_THUMBNAIL_HEIGHT - 1 },
      GRID,
      0,
    );
  }
  for (let y = 20; y < ROUTE_THUMBNAIL_HEIGHT; y += 64) {
    drawLine(
      pixels,
      { x: 0, y },
      { x: ROUTE_THUMBNAIL_WIDTH - 1, y },
      GRID,
      0,
    );
  }
}

function mercator(route: ReadonlyArray<RouteCoordinate>): PixelPoint[] {
  const output: PixelPoint[] = [];
  let previousX: number | null = null;
  for (const point of route) {
    const rawX = (point.longitude + 180) / 360;
    let x = rawX;
    if (previousX != null) {
      while (x - previousX > 0.5) x -= 1;
      while (x - previousX < -0.5) x += 1;
    }
    previousX = x;
    const latitude = Math.max(-85.05112878, Math.min(85.05112878, point.latitude));
    const radians = (latitude * Math.PI) / 180;
    const y =
      (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) /
      2;
    output.push({ x, y });
  }
  return output;
}

function canvasTransform(route: ReadonlyArray<RouteCoordinate>) {
  const source = mercator(route);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of source) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const padding = 38;
  const availableWidth = ROUTE_THUMBNAIL_WIDTH - padding * 2;
  const availableHeight = ROUTE_THUMBNAIL_HEIGHT - padding * 2;
  const spanX = Math.max(maxX - minX, 1e-7);
  const spanY = Math.max(maxY - minY, 1e-7);
  const scale = Math.min(availableWidth / spanX, availableHeight / spanY);
  const drawnWidth = (maxX - minX) * scale;
  const drawnHeight = (maxY - minY) * scale;
  const offsetX = (ROUTE_THUMBNAIL_WIDTH - drawnWidth) / 2;
  const offsetY = (ROUTE_THUMBNAIL_HEIGHT - drawnHeight) / 2;
  const centreX = (minX + maxX) / 2;

  const convert = (point: PixelPoint): PixelPoint => ({
    x: offsetX + (point.x - minX) * scale,
    y: offsetY + (point.y - minY) * scale,
  });
  return {
    source,
    convert,
    projectCoordinate: (coordinate: RouteCoordinate): PixelPoint => {
      const projected = mercator([coordinate])[0];
      if (!projected) return convert({ x: centreX, y: (minY + maxY) / 2 });

      // A split coordinate is projected independently, so align its world copy
      // with the unwrapped route before applying the shared canvas transform.
      while (projected.x - centreX > 0.5) projected.x -= 1;
      while (projected.x - centreX < -0.5) projected.x += 1;
      return convert(projected);
    },
  };
}

function projectToCanvas(route: ReadonlyArray<RouteCoordinate>): PixelPoint[] {
  const transform = canvasTransform(route);
  return transform.source.map(transform.convert);
}

function projectKnownCoordinates(
  route: ReadonlyArray<RouteCoordinate>,
  coordinates: ReadonlyArray<RouteCoordinate>,
): PixelPoint[] {
  if (coordinates.length === 0) return [];
  const transform = canvasTransform(route);
  return coordinates.map(transform.projectCoordinate);
}

function drawRoute(
  pixels: Buffer,
  points: ReadonlyArray<PixelPoint>,
  colour: Colour,
  radius: number,
): void {
  if (points.length === 1 && points[0]) {
    drawCircle(pixels, points[0], radius, colour);
    return;
  }
  for (let i = 1; i < points.length; i += 1) {
    const from = points[i - 1];
    const to = points[i];
    if (from && to) drawLine(pixels, from, to, colour, radius);
  }
}

function drawLine(
  pixels: Buffer,
  from: PixelPoint,
  to: PixelPoint,
  colour: Colour,
  radius: number,
): void {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
  for (let i = 0; i <= steps; i += 1) {
    const point = {
      x: from.x + (dx * i) / steps,
      y: from.y + (dy * i) / steps,
    };
    if (radius === 0) setPixel(pixels, Math.round(point.x), Math.round(point.y), colour);
    else drawCircle(pixels, point, radius, colour);
  }
}

function drawCircle(
  pixels: Buffer,
  centre: PixelPoint,
  radius: number,
  colour: Colour,
): void {
  const cx = Math.round(centre.x);
  const cy = Math.round(centre.y);
  const squared = radius * radius;
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      if (x * x + y * y <= squared) setPixel(pixels, cx + x, cy + y, colour);
    }
  }
}

function drawRing(
  pixels: Buffer,
  centre: PixelPoint,
  radius: number,
  thickness: number,
  colour: Colour,
): void {
  const cx = Math.round(centre.x);
  const cy = Math.round(centre.y);
  const outside = radius * radius;
  const inside = (radius - thickness) * (radius - thickness);
  for (let y = -radius; y <= radius; y += 1) {
    for (let x = -radius; x <= radius; x += 1) {
      const distance = x * x + y * y;
      if (distance <= outside && distance >= inside) {
        setPixel(pixels, cx + x, cy + y, colour);
      }
    }
  }
}

function setPixel(
  pixels: Buffer,
  x: number,
  y: number,
  colour: Colour,
): void {
  if (
    x < 0 ||
    y < 0 ||
    x >= ROUTE_THUMBNAIL_WIDTH ||
    y >= ROUTE_THUMBNAIL_HEIGHT
  ) {
    return;
  }
  const index = (y * ROUTE_THUMBNAIL_WIDTH + x) * 4;
  pixels[index] = colour.r;
  pixels[index + 1] = colour.g;
  pixels[index + 2] = colour.b;
  pixels[index + 3] = colour.a;
}

function haversineM(a: RouteCoordinate, b: RouteCoordinate): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLng = radians(b.longitude - a.longitude);
  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(a.latitude)) *
      Math.cos(radians(b.latitude)) *
      Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(value)));
}

function locateSplitCoordinates(
  route: ReadonlyArray<RouteCoordinate>,
  splits: ReadonlyArray<IActivitySplit>,
): RouteCoordinate[] {
  if (route.length < 2 || splits.length < 2) return [];
  const targets: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < splits.length - 1; i += 1) {
    const split = splits[i];
    if (!split || split.distanceM <= 0) continue;
    cumulative += split.distanceM;
    if (!split.isPartial) targets.push(cumulative);
  }

  const found: RouteCoordinate[] = [];
  let travelled = 0;
  let targetIndex = 0;
  for (let i = 1; i < route.length && targetIndex < targets.length; i += 1) {
    const from = route[i - 1];
    const to = route[i];
    if (!from || !to) continue;
    const leg = haversineM(from, to);
    if (leg <= 0) continue;
    while (targetIndex < targets.length && (targets[targetIndex] ?? Infinity) <= travelled + leg) {
      const fraction = ((targets[targetIndex] ?? travelled) - travelled) / leg;
      let longitudeDelta = to.longitude - from.longitude;
      while (longitudeDelta > 180) longitudeDelta -= 360;
      while (longitudeDelta < -180) longitudeDelta += 360;
      let longitude = from.longitude + longitudeDelta * fraction;
      while (longitude > 180) longitude -= 360;
      while (longitude < -180) longitude += 360;
      found.push({
        latitude: from.latitude + (to.latitude - from.latitude) * fraction,
        longitude,
      });
      targetIndex += 1;
    }
    travelled += leg;
  }
  return found;
}

function encodePng(pixels: Buffer, width: number, height: number): Buffer {
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const destination = y * (1 + width * 4);
    scanlines[destination] = 0;
    pixels.copy(scanlines, destination + 1, y * width * 4, (y + 1) * width * 4);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBuffer.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 8 + data.length);
  return chunk;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
