const fetch = require("node-fetch");
const flatbush = require("flatbush");
const Pbf = require("pbf");
const geobuf = require("geobuf");
const fs = require("fs");
const path = require("path");
const makeBBox = require("@turf/bbox").default;

const DATASET_LOCATION = "https://d3dkn3cj5tf08d.cloudfront.net";

const collection = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "examples.geojson").toString())
);

(async () => {
  for (const example of collection.features) {
    await createExample(makeBBox(example), example.properties.name);
  }
})();

async function createExample(bbox, name) {
  const response = await fetch(DATASET_LOCATION + "/metadata.json");
  const metadata = await response.json();
  const resp = await fetch(DATASET_LOCATION + metadata.index.location);
  const indexData = await resp.arrayBuffer();
  const index = flatbush.from(indexData);
  const bundleIds = index.search(...bbox);
  console.log(`Fetching ${bundleIds.length} bundles`);
  const collections = await Promise.all(
    bundleIds.map((id) => {
      return fetch(
        DATASET_LOCATION + metadata.index.rootDir + "/" + id + ".pbf"
      )
        .then((r) => r.arrayBuffer())
        .then((data) => geobuf.decode(new Pbf(data)));
    })
  );
  const featureCollection = {
    type: "FeatureCollection",
    features: collections.reduce((features, collection) => {
      // Reverse rings until dataset is fixed by new version of bundle-features
      features.push(
        ...collection.features.filter((f) => {
          const a = makeBBox(f);
          const b = bbox;
          // overlap test since bundles sometimes aren't entirely well packed
          if (a[2] >= b[0] && b[2] >= a[0] && a[3] >= b[1] && b[3] >= a[1]) {
            return true;
          }
          return false;
        })
      );
      return features;
    }, []),
  };

  const filepath = path.join(__dirname, "../examples", name + ".geojson");
  fs.writeFileSync(filepath, JSON.stringify(featureCollection));
  console.log(`Created ${filepath}`);
}
