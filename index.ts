import getEvents from "./src/getEvents";
import makePolygons from "./src/makePolygons";
import { FeatureCollection, Polygon, MultiPolygon } from "geojson";
import { EventIndex } from "./src/eventIndex";

/**
 * Given a geojson FeatureCollection representing subdivided pieces of one or
 * more polygons, union them back into their original shapes. This function is
 * designed to perform well when assembling a subset of a subdivided dataset for
 * a single bounding box.
 * @export
 * @param {(FeatureCollection<Polygon | MultiPolygon>)} collection
 * @param {string} [originalIdProperty] Property on Features used to indicate
 * which source Polygon they are a part of. When provided this can roughly
 * double performance in datasets with many polygons.
 * @returns {(FeatureCollection<Polygon | MultiPolygon>)}
 */
export function union(
  collection: FeatureCollection<Polygon | MultiPolygon>,
  originalIdProperty?: string
): FeatureCollection<Polygon | MultiPolygon> {
  const { events, interiorRings, independentFeatures } = getEvents(
    collection,
    originalIdProperty
  );
  const index = new EventIndex(events);
  const outputCollection = makePolygons(collection, index, interiorRings);
  outputCollection.features.push(...independentFeatures);
  return outputCollection;
}
