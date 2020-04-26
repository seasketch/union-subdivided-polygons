import {
  FeatureCollection,
  Polygon,
  MultiPolygon,
  Feature,
  Position,
} from "geojson";
import { Event } from "./getEvents";
import { EventIndex } from "./eventIndex";

enum Direction {
  Horizontal,
  Vertical,
}

export default function makePolygons(
  collection: FeatureCollection<Polygon | MultiPolygon>,
  index: EventIndex,
  interiorRings: { [polygonId: number]: Position[][] },
  originalIdField?: string
): FeatureCollection<MultiPolygon | Polygon> {
  index.resetProcessedState();
  const outputCollection: FeatureCollection<MultiPolygon | Polygon> = {
    type: "FeatureCollection",
    features: [],
  };
  let nextExteriorRing: Event | null = index.getNextExteriorRing();
  while (nextExteriorRing) {
    let event: Event | null = nextExteriorRing;
    let prev: Event | null = null;
    const addedPositions: {
      [key: string]: { index: number; count: number };
    } = {};
    const duplicateCoordinateLocations: number[] = [];
    let coordinates: Position[] = [event.position];
    let hasEventOffEdge = false;
    const collectedFeatureIds: number[] = [];
    while (event) {
      if (
        coordinates.length > 1 &&
        event.position[0] === nextExteriorRing.position[0] &&
        event.position[1] === nextExteriorRing.position[1]
      ) {
        // Found starting point. Finish complete polygon
        break;
      }
      hasEventOffEdge = hasEventOffEdge || event.trailingCoordinates.length > 0;
      index.recordTouchedPolygons([event.polygonId]);
      if (collectedFeatureIds.indexOf(event.featureId) === -1) {
        collectedFeatureIds.push(event.featureId);
      }

      // Track duplicate vertices
      const key = event.position.join(",");
      if (addedPositions[key]) {
        duplicateCoordinateLocations.push(
          addedPositions[key].index,
          coordinates.length - 1
        );
        addedPositions[key].count++;
        if (addedPositions[key].count > 3) {
          throw new Error("Looping through the same path");
        }
      } else {
        addedPositions[key] = {
          index: coordinates.length - 1,
          count: 1,
        };
      }

      // Get the next vertex in the event chain. If there is another event with
      // an exact matching position, it's from another subdivided feature and
      // should be followed.
      let destination = pickNext(event, index);

      // Any time you are moving straight along the edge of a feature a couple
      // edge cases can happen that disrupt the simple following of straight
      // matches along boundaries. TODO: add ascii art
      // 1. There could be a vertex "behind you" indicating that you are
      //    erroneously turning inward when hitting a "wall"
      // 2. There could be an event between your origin and destination, coming
      //    from a polygon to the right.

      // First, detect if travelling straight along a boundary with no vertices
      // in between the origin and destination. If so, tests for those two
      // conditions must be performed
      if (
        // prev &&
        // If there are interim coords, this isn't going straight along the
        // boundary. Note checking event.next rather than destination, since it
        // could be jumping to another tile
        event.next.trailingCoordinates.length === 0 &&
        // Matching on any axis is good enough
        (event.position[0] === destination.position[0] ||
          event.position[1] === destination.position[1])
      ) {
        let { behind, inPath } = eventsInPlane(event, destination, index);
        // Case 1. Check for vertex behind you ("hitting a wall")
        //
        //         o--------c---------o
        //         |        ^         |
        //         |        |         |
        //         |   A    |    B    |
        //         |        |         |
        //         a------>-b         |
        //                  |         |
        //                  |         |
        //                  d---------o
        //
        // Event chain from (b) wants to go to (c), but really it should connect
        // to (d), which can only be determined by looking for events in the
        // same plane
        //
        // It's really important not to let the polygon "walk back into itself"
        // in circumstances where the input data isn't great. Self intersections
        // can cause problems. An easy test is to see if any of the coordinates
        // behind are from the same polygon. If so, it's not a valid Case 1.

        if (
          !behind.find(
            (e) =>
              e.polygonId === event?.polygonId ||
              e.polygonId === prev?.polygonId ||
              // Check added positions, taking into account that the polygon
              // may be closing
              (addedPositions[e.position.join(",")] &&
                !(e !== prev && behind.length === 1 && e === nextExteriorRing))
          )
        ) {
          // First, check for a special case of 1, let's call it 1b. This happens
          // where Polygon A has another polygon "behind" b, but Polygon B also
          // has a single vertex along the c->d plane that matches it. In these
          // cases where the first 2 elements of the before array have matching
          // coordinates, filter out the one whose next node follows the same
          // plane rather than diverging out
          if (
            behind.length > 1 &&
            behind[0].position[0] === behind[1].position[0] &&
            behind[0].position[1] === behind[1].position[1]
          ) {
            // Case 1b
            const commonPlane =
              event.position[0] === behind[0].position[0] ? 0 : 1;
            behind = [
              ...behind
                .slice(0, 2)
                .filter(
                  (e) =>
                    e.next.trailingCoordinates.length > 0 ||
                    e.next.position[commonPlane] !==
                      behind[0].position[commonPlane]
                ),
              ...behind.slice(2),
            ];
          }
          if (
            behind.length &&
            // Only on an exterior ring if the number of coordinates to the
            // right is odd
            behind.length % 2 !== 0
          ) {
            coordinates.push(behind[0].position);
            prev = event;
            event = behind[0];
            continue;
          }
        }

        // Case 2. Check for vertex in the path ("T-intersection")
        if (inPath.length) {
          // Found a neighbor. Follow the closest link to the right
          coordinates.push(inPath[0].position);
          prev = event;
          event = inPath[0];
          continue;
        }
      }

      // Finally if not hitting a wall and nothing is in the way, proceed to
      // the destination.
      coordinates.push(...event.next.trailingCoordinates);
      if (!duplicateCoPlanarEvents(event, destination)) {
        coordinates.push(destination.position);
      }
      prev = event;
      event = destination;
    }

    // Done with this exterior ring.
    event = null;
    prev = null;

    // If no events touch an edge, it means this polygon is an interior square
    // bound within its neighbors
    if (hasEventOffEdge) {
      // TODO: find interior rings that span boundaries
      const interior: Position[][] = [];
      for (const id of index.getTouchedPolygonIds()) {
        interior.push(...interiorRings[id]);
      }
      // Copy props from any feature that was the source of a used event
      const properties = collection.features[collectedFeatureIds[0]].properties;

      // duplicate vertices represent "pinches" that create multipolygons
      let segments: Position[][] = [];
      if (duplicateCoordinateLocations.length) {
        for (var i = 0; i < duplicateCoordinateLocations.length; i++) {
          segments.push(
            coordinates.slice(
              i === 0 ? 0 : duplicateCoordinateLocations[i - 1],
              duplicateCoordinateLocations[i] + 1
            )
          );
          if (i === duplicateCoordinateLocations.length - 1) {
            segments.push(
              coordinates.slice(duplicateCoordinateLocations[i] + 1)
            );
          }
        }
        while (segments.length) {
          let coordinates: Position[] = [];
          if (segments.length === 1) {
            coordinates = segments.pop()!;
            // coordinates.push(coordinates[0]);
          } else if (segments.length > 1) {
            coordinates = [...segments.shift()!, ...segments.pop()!];
          }
          const feature = {
            type: "Feature",
            properties,
            geometry: {
              type: "Polygon",
              coordinates: [
                // exterior ring
                coordinates,
                // interior rings
                ...interior,
              ],
            },
          } as Feature<Polygon>;
          // If there are no points of the edge this is an interior square
          outputCollection.features.push(feature);
        }
      } else {
        // if (coordinates[0] !== coordinates[coordinates.length - 1]) {
        //   coordinates.push(coordinates[0]);
        // }
        // Simple feature without any pinches
        const feature = {
          type: "Feature",
          // Copy properties from any feature that was the source of a used event
          properties,
          geometry: {
            type: "Polygon",
            coordinates: [
              // exterior ring
              coordinates,
              // interior rings
              ...interior,
            ],
          },
        } as Feature<Polygon>;
        // If there are no points of the edge this is an interior square
        outputCollection.features.push(feature);
      }
    }
    // The information used about "touched polygons" could be used in the future
    // to find and include interior rings, which should consist entirely of
    // directly bookmatched coordinates without all the edge cases of orthogonal
    // edge matches
    index.markTouchedPolygonsAsProcessed();
    nextExteriorRing = index.getNextExteriorRing();
  }

  // merge polygons with matching ids into multipolygons
  if (originalIdField) {
    const byId = outputCollection.features.reduce((lookup, feature) => {
      if (!feature.properties) {
        throw new Error(
          "originalIdField supplied but properties not present on feature"
        );
      }
      const existing = lookup[feature.properties[originalIdField].toString()];
      if (existing) {
        if (existing.geometry.type === "Polygon") {
          // @ts-ignore
          existing.geometry.type = "MultiPolygon";
          // @ts-ignore
          existing.geometry.coordinates = [existing.geometry.coordinates];
        }
        if (existing.geometry.type === "MultiPolygon") {
          if (feature.geometry.type === "MultiPolygon") {
            existing.geometry.coordinates.push(...feature.geometry.coordinates);
          } else {
            existing.geometry.coordinates.push(feature.geometry.coordinates);
          }
        }
      } else {
        lookup[feature.properties[originalIdField].toString()] = feature;
      }
      return lookup;
    }, {} as { [id: string]: Feature<Polygon | MultiPolygon> });
    outputCollection.features = Object.values(byId);
  }

  return outputCollection;
}

// Detects when the start, destination, and next.destination are all in the same
// plane so that duplicates along a line can be de-duped.
function duplicateCoPlanarEvents(start: Event, destination: Event) {
  // Winding trail, not a straight path
  if (
    destination.trailingCoordinates.length ||
    destination.next.trailingCoordinates
  ) {
    return false;
  }
  const straightX =
    start.position[0] === destination.position[0] &&
    destination.position[0] === destination.next.position[0];
  const straightY =
    start.position[1] === destination.position[1] &&
    destination.position[1] === destination.next.position[1];
  return straightX || straightY;
}

// Given a choice between many overlapping points, prefer destinations from
// other polygons that aren't 90deg corners, then corners, then the next in the
// original polygon chain
function pickNext(origin: Event, index: EventIndex): Event {
  const overlapping: Event[] = index
    .getByPosition(origin.next.position)
    .filter((e) => e.polygonId !== origin.polygonId);
  if (overlapping.length === 0) {
    // If there's no overlap there is no choice but to follow the path
    return origin.next;
  } else {
    const nextEvent = overlapping.sort((a, b) => {
      if (a.isNinetyDegreeCorner && !b.isNinetyDegreeCorner) {
        return 1;
      } else if (b.isNinetyDegreeCorner && !a.isNinetyDegreeCorner) {
        return -1;
      } else {
        return 0;
      }
    })[0];
    return nextEvent;
  }
}

function eventsInPlane(start: Event, destination: Event, index: EventIndex) {
  const direction: Direction =
    start.position[0] === destination.position[0]
      ? Direction.Vertical
      : Direction.Horizontal;
  const vary = direction === Direction.Vertical ? 1 : 0;
  const events =
    direction === Direction.Vertical
      ? index.getByX(start.position)
      : index.getByY(start.position);
  const ascending = start.position[vary] < destination.position[vary];
  return {
    behind: events
      .filter((e) =>
        ascending
          ? e.position[vary] < start.position[vary]
          : e.position[vary] > start.position[vary]
      )
      .sort((a, b) => {
        if (ascending) {
          return b.position[vary] - a.position[vary];
        } else {
          return a.position[vary] - b.position[vary];
        }
      }),
    inPath: events
      .filter((e) =>
        ascending
          ? e.position[vary] > start.position[vary] &&
            e.position[vary] < destination.position[vary]
          : e.position[vary] < start.position[vary] &&
            e.position[vary] > destination.position[vary]
      )
      .sort((a, b) => {
        if (ascending) {
          return a.position[vary] - b.position[vary];
        } else {
          return b.position[vary] - a.position[vary];
        }
      }),
  };
}
