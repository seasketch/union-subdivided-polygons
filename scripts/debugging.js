const { createPool, sql } = require("slonik");
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");

module.exports = {
  getExamplesCollection: () => {
    const examples = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "examples.geojson")).toString()
    );
    return examples;
  },
  getExampleByPath: (examplePath) => {
    if (!fs.existsSync(examplePath)) {
      throw new Error(
        `Could not find file at provided example path ${examplePath}`
      );
    }
    const collection = JSON.parse(fs.readFileSync(examplePath).toString());
    if (!collection.type === "FeatureCollection") {
      throw new Error("Example must be of type FeatureCollection");
    }
    return collection;
  },
  setupDb: async (connection) => {
    await connection.query(
      sql`
        drop table if exists union_subdivided_polygons_output_errors;
        drop table if exists union_subdivided_polygons_input_errors;
        drop table if exists union_subdivided_polygons_events; 
        drop table if exists union_subdivided_polygons_output; 
        drop table if exists union_subdivided_polygons_input; 
        drop table if exists union_subdivided_polygons_bboxes;
    
        create table union_subdivided_polygons_events (
          id serial primary key, 
          event_id int,
          trailing_coordinates int, 
          last_position boolean,
          first_position boolean,
          feature_id int,
          polygon_id int,
          index int,
          corner boolean,
          geom Geometry,
          next int
        );
        CREATE INDEX union_subdivided_polygons_index_events ON union_subdivided_polygons_events USING gist(geom);
    
        create table union_subdivided_polygons_output ( 
          id serial primary key, 
          name text, 
          geom Geometry 
        );
        CREATE INDEX union_subdivided_polygons_index_output ON union_subdivided_polygons_output USING gist(geom);
        create table union_subdivided_polygons_input ( 
          id serial primary key, 
          name text, geom Geometry 
        );
        CREATE INDEX union_subdivided_polygons_index_input ON union_subdivided_polygons_input USING gist(geom);
        create table union_subdivided_polygons_bboxes ( 
          id serial primary key, 
          geom Geometry 
        );
    
        create table union_subdivided_polygons_output_errors ( 
          id serial primary key, 
          name text, 
          geom Geometry, 
          reason text 
        );
        create table union_subdivided_polygons_input_errors ( 
          id serial primary key, 
          name text, 
          geom Geometry, 
          reason text 
        );

        `
    );
  },
  saveArtifacts: async (
    connection,
    exampleName,
    bboxes,
    events,
    input,
    output
  ) => {
    if (bboxes.length) {
      await connection.query(sql`
        insert into union_subdivided_polygons_bboxes (geom) 
        values ${sql.join(
          bboxes.map(
            (bbox) =>
              sql`(st_makeenvelope(${bbox[0]}, ${bbox[1]}, ${bbox[2]}, ${bbox[3]}))`
          ),
          ", "
        )}
      `);
    }
    if (events.length) {
      await connection.query(sql`
      insert into union_subdivided_polygons_events (
        event_id, 
        trailing_coordinates, 
        last_position, 
        first_position, 
        feature_id, 
        polygon_id, 
        index, 
        corner, 
        next,
        geom 
      ) 
      values ${sql.join(
        events.map(
          (event) =>
            sql`(
              ${event.id}, 
              ${event.trailingCoordinates.length}, 
              ${event.lastPosition === true}, 
              ${event.firstPosition === true}, 
              ${event.featureId}, 
              ${event.polygonId}, 
              ${event.index}, 
              ${event.isNinetyDegreeCorner}, 
              ${event.next ? event.next.id : 9999999}, 
              st_geomfromgeojson(${JSON.stringify({
                type: "Point",
                coordinates: event.position,
              })}))`
        ),
        ", "
      )}
    `);
    }

    await connection.query(sql`
      insert into union_subdivided_polygons_input (name, geom) values ${sql.join(
        input.features.map(
          (feature) =>
            sql`(${exampleName}, st_geomfromgeojson(${JSON.stringify(
              feature.geometry
            )}))`
        ),
        ", "
      )}
    `);

    const inputErrors = await connection.any(sql`
      select 
        id, 
        ST_AsText(location(ST_IsValidDetail(geom))) as location, 
        reason(ST_IsValidDetail(geom)) as reason 
      from union_subdivided_polygons_input 
      where name = ${exampleName} and st_isvalid(geom) = false
    `);

    if (inputErrors.length) {
      await connection.query(
        sql`insert into union_subdivided_polygons_input_errors (geom, reason) 
        values ${sql.join(
          inputErrors.map(
            (e) => sql`(st_geomfromtext(${e.location}), ${e.reason})`
          ),
          ","
        )}`
      );
    }

    if (output) {
      await connection.query(sql`
        insert into union_subdivided_polygons_output (name, geom) 
        values ${sql.join(
          output.features.map(
            (feature) =>
              sql`(${exampleName}, st_geomfromgeojson(${JSON.stringify(
                feature.geometry
              )}))`
          ),
          ", "
        )}
      `);
      const outputErrors = await connection.any(sql`
        select 
          id, 
          ST_AsText(location(ST_IsValidDetail(geom))) as location, 
          reason(ST_IsValidDetail(geom)) as reason 
        from union_subdivided_polygons_output 
        where st_isvalid(geom) = false and name = ${exampleName}
      `);
      if (outputErrors.length) {
        await connection.query(
          sql`insert into union_subdivided_polygons_output_errors (geom, reason) 
          values ${sql.join(
            outputErrors.map(
              (e) => sql`(st_geomfromtext(${e.location}), ${e.reason})`
            ),
            ","
          )}`
        );
      }
      return { inputErrors, outputErrors };
    } else {
      return { inputErrors, outputErrors: [] };
    }
  },
  printErrors: (inputErrors, outputErrors) => {
    if (inputErrors.length) {
      const newErrors = outputErrors.filter(
        (e) => !inputErrors.find((i) => e.location === i.location)
      );
      if (newErrors.length) {
        console.log(
          chalk.red(
            `${inputErrors.length} errors in source. ${newErrors.length} *new* errors in output.`
          )
        );
        for (const error of outputErrors) {
          console.log(`(id=${error.id}): ${error.reason} ${error.location}`);
        }
      } else {
        console.log(
          chalk.yellow(`${inputErrors.length} issues with source geometry`)
        );
      }
    } else if (outputErrors.length) {
      console.error(
        chalk.red(`${outputErrors.length} geometry validation errors in output`)
      );
      for (const error of outputErrors) {
        console.log(`(id=${error.id}): ${error.reason} ${error.location}`);
      }
    }
  },
};
