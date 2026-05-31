/**
 * Ride the Wind — GPX route processing
 *
 * Pure, dependency-free ES module. Turns a GPX track into the processed
 * route the prediction model consumes: an ordered list of fixed-spacing
 * segments, each with a great-circle bearing, distance, and elevation delta.
 *
 * Pipeline:   parseGpx → resample → buildSegments → summarise
 * Public API: processGpx(gpxText, options) → ProcessedRoute
 *
 * No DOM dependency beyond DOMParser (available in browsers). For Node tests
 * a DOMParser shim can be injected via options.domParser.
 *
 * @typedef {Object} TrackPoint
 * @property {number} lat   - decimal degrees
 * @property {number} lon   - decimal degrees
 * @property {number|null} ele - metres, or null if absent
 *
 * @typedef {Object} Segment
 * @property {number} lat       - start latitude of the segment
 * @property {number} lon       - start longitude of the segment
 * @property {number} bearing   - initial great-circle bearing, degrees [0,360)
 * @property {number} distance  - segment length, metres
 * @property {number|null} eleDelta - elevation change over the segment, metres
 *
 * @typedef {Object} ProcessedRoute
 * @property {Segment[]} segments
 * @property {number} totalDistance - metres
 * @property {{lat:number,lon:number}} start
 * @property {{lat:number,lon:number}} end
 * @property {boolean} hasElevation
 * @property {{maxGap:number, pointCount:number}} diagnostics
 */

const EARTH_RADIUS_M = 6371008.8; // mean Earth radius (IUGG)
const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

/* ------------------------------------------------------------------ *
 * Geometry helpers
 * ------------------------------------------------------------------ */

/**
 * Great-circle (haversine) distance between two lat/lon points, in metres.
 */
export function haversine(aLat, aLon, bLat, bLon) {
  const dLat = (bLat - aLat) * DEG;
  const dLon = (bLon - aLon) * DEG;
  const lat1 = aLat * DEG;
  const lat2 = bLat * DEG;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Initial bearing (forward azimuth) from point A to point B, in degrees
 * [0,360), measured clockwise from true north. This is the direction the
 * rider is travelling, which the wind model decomposes against.
 */
export function bearing(aLat, aLon, bLat, bLon) {
  const lat1 = aLat * DEG;
  const lat2 = bLat * DEG;
  const dLon = (bLon - aLon) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  const brng = Math.atan2(y, x) * RAD;
  return (brng + 360) % 360;
}

/**
 * Linear interpolation of a point a fraction `t` of the way from A to B.
 * Adequate at the ~50–100 m spacing we resample to; the curvature error
 * over such short hops is negligible for wind purposes.
 */
function interpolatePoint(a, b, t) {
  return {
    lat: a.lat + (b.lat - a.lat) * t,
    lon: a.lon + (b.lon - a.lon) * t,
    ele:
      a.ele == null || b.ele == null ? null : a.ele + (b.ele - a.ele) * t,
  };
}

/* ------------------------------------------------------------------ *
 * GPX parsing
 * ------------------------------------------------------------------ */

/**
 * Parse GPX text into an array of TrackPoints.
 * Reads <trkpt> elements (track), falling back to <rtept> (route) if no
 * track is present — hand-drawn routes from planners often use <rtept>.
 *
 * @param {string} gpxText
 * @param {{domParser?: DOMParser}} [options]
 * @returns {TrackPoint[]}
 */
export function parseGpx(gpxText, options = {}) {
  if (typeof gpxText !== "string" || gpxText.trim() === "") {
    throw new GpxError("EMPTY_FILE", "GPX file is empty.");
  }

  const parser =
    options.domParser ||
    (typeof DOMParser !== "undefined" ? new DOMParser() : null);
  if (!parser) {
    throw new GpxError(
      "NO_PARSER",
      "No DOMParser available; pass options.domParser in non-browser environments."
    );
  }

  const doc = parser.parseFromString(gpxText, "application/xml");

  // DOMParser reports malformed XML via a <parsererror> node rather than throwing.
  const parseError = doc.getElementsByTagName("parsererror");
  if (parseError && parseError.length > 0) {
    throw new GpxError("MALFORMED_XML", "GPX file is not valid XML.");
  }

  let nodes = Array.from(doc.getElementsByTagName("trkpt"));
  if (nodes.length === 0) {
    nodes = Array.from(doc.getElementsByTagName("rtept"));
  }
  if (nodes.length === 0) {
    throw new GpxError("NO_POINTS", "GPX file contains no track points.");
  }

  const points = [];
  for (const node of nodes) {
    const lat = parseFloat(node.getAttribute("lat"));
    const lon = parseFloat(node.getAttribute("lon"));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const eleNode = node.getElementsByTagName("ele")[0];
    const ele = eleNode ? parseFloat(eleNode.textContent) : null;

    points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null });
  }

  if (points.length < 2) {
    throw new GpxError(
      "TOO_FEW_POINTS",
      "GPX track needs at least two valid points."
    );
  }
  return points;
}

/* ------------------------------------------------------------------ *
 * Resampling
 * ------------------------------------------------------------------ */

/**
 * Resample a track to (approximately) even spacing. Recorded GPS tracks are
 * noisy and densely sampled; resampling smooths per-segment bearings, keeps
 * forecast queries minimal, and costs no meaningful accuracy since wind does
 * not vary at finer resolution.
 *
 * Walks the original polyline accumulating distance, emitting a point every
 * `spacing` metres by interpolating along the current leg. First and last
 * original points are always preserved.
 *
 * @param {TrackPoint[]} points
 * @param {number} spacing - target spacing in metres
 * @returns {TrackPoint[]}
 */
export function resample(points, spacing = 75) {
  if (spacing <= 0) throw new GpxError("BAD_SPACING", "Spacing must be > 0.");
  if (points.length < 2) return points.slice();

  const out = [points[0]];
  let carry = 0; // distance already covered toward the next emitted point

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const legLen = haversine(a.lat, a.lon, b.lat, b.lon);
    if (legLen === 0) continue;

    let distFromA = spacing - carry;
    while (distFromA < legLen) {
      out.push(interpolatePoint(a, b, distFromA / legLen));
      distFromA += spacing;
    }
    carry = legLen - (distFromA - spacing);
  }

  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  // Avoid a near-zero final segment by collapsing onto the true endpoint.
  if (haversine(tail.lat, tail.lon, last.lat, last.lon) > spacing * 0.25) {
    out.push(last);
  } else {
    out[out.length - 1] = last;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Segment construction & summary
 * ------------------------------------------------------------------ */

/**
 * Build segments from an ordered point list. Each segment carries the bearing
 * and distance of the hop, plus elevation delta when available.
 *
 * Also reports the largest single gap, so callers can warn on tracks with
 * big holes (a paused recording, a tunnel), per the validation requirement.
 *
 * @param {TrackPoint[]} points
 * @returns {{segments: Segment[], totalDistance: number, maxGap: number, hasElevation: boolean}}
 */
export function buildSegments(points) {
  const segments = [];
  let total = 0;
  let maxGap = 0;
  let hasElevation = false;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dist = haversine(a.lat, a.lon, b.lat, b.lon);
    if (dist > maxGap) maxGap = dist;

    const eleDelta =
      a.ele == null || b.ele == null ? null : b.ele - a.ele;
    if (eleDelta != null) hasElevation = true;

    segments.push({
      lat: a.lat,
      lon: a.lon,
      bearing: bearing(a.lat, a.lon, b.lat, b.lon),
      distance: dist,
      eleDelta,
    });
    total += dist;
  }

  return { segments, totalDistance: total, maxGap, hasElevation };
}

/* ------------------------------------------------------------------ *
 * Orchestration
 * ------------------------------------------------------------------ */

/**
 * Full pipeline: parse → resample → build segments → summarise.
 * Returns the ProcessedRoute the storage layer persists (per the data spec,
 * we store processed segments, not raw GPX).
 *
 * @param {string} gpxText
 * @param {Object} [options]
 * @param {number} [options.spacing=75]      - resample spacing, metres
 * @param {number} [options.minDistance=200] - warn below this total length
 * @param {number} [options.maxGapWarn=500]  - warn above this single gap
 * @param {DOMParser} [options.domParser]
 * @returns {ProcessedRoute & {warnings: string[]}}
 */
export function processGpx(gpxText, options = {}) {
  const {
    spacing = 75,
    minDistance = 200,
    maxGapWarn = 500,
    domParser,
  } = options;

  const raw = parseGpx(gpxText, { domParser });
  const sampled = resample(raw, spacing);
  const { segments, totalDistance, maxGap, hasElevation } =
    buildSegments(sampled);

  const warnings = [];
  if (totalDistance < minDistance) {
    warnings.push(
      `Track is very short (${Math.round(totalDistance)} m).`
    );
  }
  if (maxGap > maxGapWarn) {
    warnings.push(
      `Track has a large gap (${Math.round(maxGap)} m) — recording may have paused.`
    );
  }

  return {
    segments,
    totalDistance,
    start: { lat: sampled[0].lat, lon: sampled[0].lon },
    end: {
      lat: sampled[sampled.length - 1].lat,
      lon: sampled[sampled.length - 1].lon,
    },
    hasElevation,
    diagnostics: { maxGap, pointCount: sampled.length },
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class GpxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GpxError";
    this.code = code; // machine-readable: EMPTY_FILE, NO_POINTS, MALFORMED_XML, ...
  }
}
