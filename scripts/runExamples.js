const fs = require("fs");
const path = require("path");
const { createPool, sql } = require("slonik");
const getEvents = require("../dist/src/getEvents").default;
const makePolygons = require("../dist/src/makePolygons").default;
const { EventIndex } = require("../dist/src/eventIndex");
const bytes = require("pretty-bytes");
const {
  getExamplesCollection,
  setupDb,
  saveArtifacts,
  printErrors,
} = require("./debugging");

const connectionString =
  process.env.DB || "postgres://docker:docker@localhost:54322/gis";

const pool = createPool(connectionString);

(async () => {
  await pool.connect(async (connection) => {
    await setupDb(connection);
    const examplesDir = path.join(__dirname, "..", "examples");
    for (const feature of getExamplesCollection().features) {
      const filePath = path.join(
        examplesDir,
        `${feature.properties.name}.geojson`
      );
      var stats = fs.statSync(filePath);
      const collection = JSON.parse(fs.readFileSync(filePath).toString());
      console.log(
        `${feature.properties.name} (${bytes(stats["size"])}, ${
          collection.features.length
        } features)`
      );
      console.time("total");
      console.time("segmentation");
      const { events, interiorRings, bboxes, independentFeatures } = getEvents(
        collection,
        "_oid"
      );
      console.timeEnd("segmentation");
      console.time("index");
      const index = new EventIndex(events);
      console.timeEnd("index");
      console.time("polygonize");
      const unionedCollection = makePolygons(
        collection,
        index,
        interiorRings,
        "_oid"
      );
      unionedCollection.features.push(...independentFeatures);
      console.timeEnd("polygonize");
      console.timeEnd("total");

      const { inputErrors, outputErrors } = await saveArtifacts(
        connection,
        feature.properties.name,
        bboxes,
        events,
        collection,
        unionedCollection
      );
      printErrors(inputErrors, outputErrors);
      console.log("");
    }
  });
  process.exit();
})();
