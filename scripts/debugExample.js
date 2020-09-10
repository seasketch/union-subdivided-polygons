const fs = require("fs");
const path = require("path");
const {
  createPool,
  sql
} = require("slonik");
const getEvents = require("../dist/src/getEvents").default;
const makePolygons = require("../dist/src/makePolygons").default;
const {
  EventIndex
} = require("../dist/src/eventIndex");
const {
  setupDb,
  getExampleByPath,
  saveArtifacts,
  printErrors,
} = require("./debugging");

if (process.argv.length < 3) {
  throw new Error("Missing required argument. Must specify an example path");
}

const connectionString =
  process.env.DB || "postgres://docker:docker@localhost:54322/gis";

const examplePath = process.argv[2];

const collection = getExampleByPath(examplePath);

const pool = createPool(connectionString);

pool.connect(async (connection) => {
  await setupDb(connection);

  console.time("union features total");
  console.time("segmentation");
  const {
    events,
    interiorRings,
    bboxes,
    independentFeatures
  } = getEvents(
    collection,
    "_oid"
  );
  console.timeEnd("segmentation");
  console.time("index");
  const index = new EventIndex(events);
  console.timeEnd("index");
  console.time("polygonize");
  let unionedCollection;
  try {
    if (examplePath.includes("GwaiiHaanas")) {
      unionedCollection = makePolygons(collection, index, interiorRings);
    } else {
      unionedCollection = makePolygons(collection, index, interiorRings, "_oid");
    }

    unionedCollection.features.push(...independentFeatures);
  } catch (e) {
    console.error(e);
  }
  console.timeEnd("polygonize");
  console.timeEnd("union features total");

  const {
    inputErrors,
    outputErrors
  } = await saveArtifacts(
    connection,
    path.basename(examplePath, ".geojson"),
    bboxes,
    events,
    collection,
    unionedCollection
  );

  printErrors(inputErrors, outputErrors);

  console.log(
    `
Added debugging outputs to tables: 
  union_subdivided_polygons_events
  union_subdivided_polygons_input
  union_subdivided_polygons_output
  union_subdivided_polygons_bboxes
  union_subdivided_polygons_output_errors
  union_subdivided_polygons_input_errors
`
  );
});