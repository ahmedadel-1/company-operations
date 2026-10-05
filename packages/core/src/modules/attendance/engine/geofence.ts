/**
 * Geofence evaluation (ADR-0022, SECURITY §9). Pure: the caller supplies the reported position, the
 * organization's accuracy threshold and the server-computed eligible locations. The client never
 * supplies a distance, a result or a location id.
 */

const EARTH_RADIUS_METERS = 6_371_008.8;
/** Stored coordinate precision: 5 decimals ≈ 1.1 m; more is not evidence (data minimization). */
export const COORDINATE_DECIMALS = 5;

export interface Position {
  readonly latitude: number;
  readonly longitude: number;
  /** Meters, as reported by the device. */
  readonly accuracy: number;
}

export interface GeofenceLocation {
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly radiusMeters: number;
  readonly type: 'OFFICE' | 'CUSTOMER_SITE' | 'PROJECT_SITE' | 'OTHER';
}

export type GeofenceResult = 'INSIDE' | 'OUTSIDE' | 'LOW_ACCURACY';

export interface GeofenceEvaluation {
  readonly result: GeofenceResult;
  /** The matched (inside) location, otherwise the nearest one; null only without locations. */
  readonly location: GeofenceLocation | null;
  readonly distanceMeters: number | null;
  /** Accuracy rounded up to whole meters (never better than reported). */
  readonly accuracyMeters: number;
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle distance in meters (haversine, mean Earth radius). */
export function haversineMeters(
  from: { readonly latitude: number; readonly longitude: number },
  to: { readonly latitude: number; readonly longitude: number },
): number {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) * Math.cos(toRadians(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function roundCoordinate(value: number): number {
  const factor = 10 ** COORDINATE_DECIMALS;
  return Math.round(value * factor) / factor;
}

/**
 * Evaluates the position against every eligible location. Accuracy worse than the threshold is
 * `LOW_ACCURACY` — never `INSIDE`, even when the point lies within a radius. Otherwise the nearest
 * location whose radius contains the point is `INSIDE` (ties: smaller distance, then id); else
 * `OUTSIDE` against the nearest location. Distances are whole meters, rounded up.
 */
export function evaluateGeofence(
  position: Position,
  locations: readonly GeofenceLocation[],
  maxAccuracyMeters: number,
): GeofenceEvaluation {
  const accuracyMeters = Math.ceil(position.accuracy);
  const measured = locations
    .map((location) => ({ location, distance: Math.ceil(haversineMeters(position, location)) }))
    .sort((left, right) => left.distance - right.distance || (left.location.id < right.location.id ? -1 : 1));
  const nearest = measured[0];
  if (nearest === undefined) {
    return { result: 'OUTSIDE', location: null, distanceMeters: null, accuracyMeters };
  }
  const inside = measured.find((item) => item.distance <= item.location.radiusMeters);
  if (accuracyMeters > maxAccuracyMeters) {
    const best = inside ?? nearest;
    return { result: 'LOW_ACCURACY', location: best.location, distanceMeters: best.distance, accuracyMeters };
  }
  if (inside !== undefined) {
    return { result: 'INSIDE', location: inside.location, distanceMeters: inside.distance, accuracyMeters };
  }
  return { result: 'OUTSIDE', location: nearest.location, distanceMeters: nearest.distance, accuracyMeters };
}
