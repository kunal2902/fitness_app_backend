export interface RouteCoordinate {
  latitude: number;
  longitude: number;
}

const PRECISION = 100_000;
const MAX_ROUTE_POINTS = 50_000;

/**
 * Decodes a Google encoded polyline at precision 5.
 *
 * The parser is intentionally strict: truncated values, characters outside
 * the polyline alphabet, out-of-range coordinates and unreasonably large
 * routes are rejected before they can reach the renderer.
 */
export function decodePolyline(encoded: string): RouteCoordinate[] {
  if (encoded.length === 0) return [];

  const points: RouteCoordinate[] = [];
  let cursor = 0;
  let latitude = 0;
  let longitude = 0;

  const readDelta = (): number => {
    let result = 0;
    let shift = 0;
    while (true) {
      if (cursor >= encoded.length) {
        throw new Error('Encoded polyline ends mid-coordinate');
      }
      const value = encoded.charCodeAt(cursor) - 63;
      cursor += 1;
      if (value < 0 || value > 63) {
        throw new Error('Encoded polyline contains an invalid character');
      }
      result |= (value & 0x1f) << shift;
      if (value < 0x20) break;
      shift += 5;
      if (shift > 30) throw new Error('Encoded polyline value is too large');
    }
    return (result & 1) === 1 ? ~(result >> 1) : result >> 1;
  };

  while (cursor < encoded.length) {
    latitude += readDelta();
    longitude += readDelta();
    const point = {
      latitude: latitude / PRECISION,
      longitude: longitude / PRECISION,
    };
    if (
      !Number.isFinite(point.latitude) ||
      !Number.isFinite(point.longitude) ||
      point.latitude < -90 ||
      point.latitude > 90 ||
      point.longitude < -180 ||
      point.longitude > 180
    ) {
      throw new Error('Encoded polyline contains an out-of-range coordinate');
    }
    points.push(point);
    if (points.length > MAX_ROUTE_POINTS) {
      throw new Error(`Encoded polyline exceeds ${MAX_ROUTE_POINTS} points`);
    }
  }

  return points;
}
