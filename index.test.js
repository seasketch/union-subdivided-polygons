const path = require("path");
const fs = require("fs");
const { createPool, sql } = require("slonik");
const { union } = require("./dist/index");
const { getExamplesCollection } = require("./scripts/debugging");

const EXAMPLES_DIR = "examples";

const connectionString =
  process.env.DB || "postgres://docker:docker@localhost:54322/gis";

const pool = createPool(connectionString);

jest.setTimeout(10000);

describe("Run all examples", () => {
  const examplesCollection = getExamplesCollection();
  for (const feature of getExamplesCollection().features) {
    test(feature.properties.name, async () => {
      const filePath = path.join(
        EXAMPLES_DIR,
        `${feature.properties.name}.geojson`
      );
      const collection = JSON.parse(fs.readFileSync(filePath).toString());
      expect(collection.features.length).toBeGreaterThan(0);
      const output = union(collection, "_oid");
      expect(output.features.length).toBeGreaterThan(0);
      await pool.connect(async (connection) => {
        await connection.transaction(async (t1) => {
          await t1.query(sql`create table jest_input (geom Geometry);`);
          await t1.query(
            sql`create table jest_input_error_locations (location text);`
          );
          await t1.query(sql`create table jest_output (geom Geometry);`);
          await t1.query(sql`
              insert into jest_input (geom) 
              values ${sql.join(
                collection.features.map(
                  (feature) =>
                    sql`(st_geomfromgeojson(${JSON.stringify(
                      feature.geometry
                    )}))`
                ),
                ", "
              )}
            `);
          await t1.query(
            sql`
              insert into jest_input_error_locations (location) 
                select 
                  ST_AsText(location(ST_IsValidDetail(geom))) 
                from jest_input where st_isvalid(geom) = false`
          );
          await t1.query(sql`
              insert into jest_output (geom) 
              values ${sql.join(
                output.features.map(
                  (feature) =>
                    sql`(st_geomfromgeojson(${JSON.stringify(
                      feature.geometry
                    )}))`
                ),
                ", "
              )}
            `);
          const errors = await t1.oneFirst(
            sql`select 
              count(*) 
            from jest_output 
            where 
              st_isvalid(geom) = false and 
              ST_AsText(location(ST_IsValidDetail(geom))) not in (
                select location from jest_input_error_locations
              )`
          );
          expect(errors).toBe(0);
          await t1.query(sql`rollback`);
        });
      });
    });
  }
});
