import {
  Feature,
  FeatureCollection,
  Polygon,
  MultiPolygon,
  Position,
  BBox,
} from "geojson";
import makeBBox from "@turf/bbox";

export interface Event {
  id: number;
  position: Position;
  featureId: number;
  polygonId: number;
  index: number;
  next: Event;
  isNinetyDegreeCorner: boolean;
  onCorner: boolean;
  trailingCoordinates: Position[];
}

// Segments polygons into "Events" which represent any vertex that intersects
// the bbox of a feature, or that represents the start or endpoint of a feature,
// and includes the trailing coordinates between that vertex and any prior event
export default function getEventsAndInteriorRings(
  collection: FeatureCollection<Polygon | MultiPolygon>,
  originalIdField?: string
) {
  const independentFeatures: Feature<Polygon | MultiPolygon>[] = [];
  const oidCounts: { [id: string]: number } = {};
  if (originalIdField) {
    for (const feature of collection.features) {
      if (feature.properties && feature.properties[originalIdField]) {
        const key = feature.properties[originalIdField];
        oidCounts[key] = (oidCounts[key] || 0) + 1;
      }
    }
  }
  const bboxes: BBox[] = [];
  let idSequence = 0;
  let polygonIdSequence = 0;
  const events: Event[] = [];
  const interiorRings: { [polygonId: number]: Position[][] } = {};
  for (var fi = 0; fi < collection.features.length; fi++) {
    const feature = collection.features[fi];
    if (
      originalIdField &&
      feature.properties &&
      feature.properties[originalIdField] &&
      oidCounts[feature.properties[originalIdField]] === 1
    ) {
      independentFeatures.push(feature);
      continue;
    }
    const bbox = feature.bbox || makeBBox(feature);
    bboxes.push(bbox);
    let polygons;
    if (feature.geometry.type === "Polygon") {
      polygons = [feature.geometry.coordinates];
    } else {
      polygons = feature.geometry.coordinates;
    }
    for (const polygon of polygons) {
      let polygonId = polygonIdSequence++;
      interiorRings[polygonId] = polygon.slice(1);
      const exteriorRing = polygon[0];
      let firstEvent: Event | null = null;
      let previousEvent: Event | null = null;
      for (var i = 0; i < exteriorRing.length; i++) {
        const position = exteriorRing[i];
        // Get rid of duplicate coordinates. Cleans up the dataset for OGC
        // simple features compliance and makes union algorithm simpler
        if (
          previousEvent &&
          previousEvent.position[0] === position[0] &&
          previousEvent.position[1] === position[1]
        ) {
          const removed = events.pop();
          // Watch out for cases where first coordinate is duplicated
          if (firstEvent && firstEvent === removed) {
            firstEvent = null;
            previousEvent = null;
          } else {
            previousEvent = events[events.length - 1];
          }
        }
        if (i === exteriorRing.length - 1) {
          // Last event, so link back to first
          previousEvent!.next = firstEvent!;
          // Don't forget to add the trailing coordinates of the dropped last
          // node to the first so that they aren't lost
          firstEvent!.trailingCoordinates = [
            ...exteriorRing.slice(previousEvent!.index + 1, i),
            ...firstEvent!.trailingCoordinates,
          ];
          break;
        }
        const onLeft = position[0] === bbox[0];
        const onRight = position[0] === bbox[2];
        const onBottom = position[1] === bbox[1];
        const onTop = position[1] === bbox[3];
        if (
          // i === 0 ||
          onLeft ||
          onRight ||
          onTop ||
          onBottom ||
          i === exteriorRing.length - 1
        ) {
          // on an edge, is an event
          const isRightAngle = () => {
            let before = exteriorRing[i - 1];
            let after = exteriorRing[i + 1];
            if (i === 0) {
              // at the begining
              before = exteriorRing[exteriorRing.length - 2];
            } else if (i === exteriorRing.length - 1) {
              // at the very end
              after = exteriorRing[1];
            }
            return isNinetyDegrees(position, before, after);
          };
          const onCorner =
            (onLeft && onBottom) ||
            (onBottom && onRight) ||
            (onTop && onRight) ||
            (onTop && onLeft);
          const e: Event = {
            id: idSequence++,
            position,
            featureId: fi,
            polygonId,
            index: i,
            trailingCoordinates: [],
            isNinetyDegreeCorner: onCorner && isRightAngle(),
            onCorner,
            // @ts-ignore
            next: null,
          };
          if (previousEvent) {
            previousEvent.next = e;
            e.trailingCoordinates = exteriorRing.slice(
              previousEvent.index + 1,
              i
            );
          } else {
            e.trailingCoordinates = exteriorRing.slice(0, i);
            firstEvent = e;
          }
          events.push(e);
          previousEvent = e;
        }
      }
    }
  }
  return {
    events,
    interiorRings,
    bboxes,
    independentFeatures,
  };
}

function isNinetyDegrees(
  center: Position,
  before: Position,
  after: Position
): boolean {
  return (
    (before[0] === center[0] && after[1] === center[1]) ||
    (before[1] === center[1] && after[0] === center[0])
  );
}
