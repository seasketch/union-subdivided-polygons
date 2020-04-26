import { Event } from "./getEvents";
import { Position } from "geojson";

export class EventIndex {
  events: Event[] = [];
  byPosition: { [key: string]: Event[] } = {};
  byX: { [x: number]: Event[] } = {};
  byY: { [y: number]: Event[] } = {};
  private removedPolygonIds: { [id: number]: boolean } = {};
  private touchedPolygonIds: { [id: number]: boolean } = {};
  private touchTable: {
    [polygonId: number]: { [polygonId: number]: boolean };
  } = {};

  constructor(events: Event[]) {
    this.events = events;
    for (const event of events) {
      const key = event.position.join(",");
      if (key in this.byPosition) {
        this.byPosition[key].push(event);
      } else {
        this.byPosition[key] = [event];
      }
      if (event.position[0] in this.byX) {
        this.byX[event.position[0]].push(event);
      } else {
        this.byX[event.position[0]] = [event];
      }
      if (event.position[1] in this.byY) {
        this.byY[event.position[1]].push(event);
      } else {
        this.byY[event.position[1]] = [event];
      }
    }
    // This could be optimized by identifying rectangular polygons in getEvents
    // and only creating the lookup table for them. It's quick enough for now
    for (const event of events) {
      if (!(event.polygonId in this.touchTable)) {
        this.touchTable[event.polygonId] = {};
      }
      const overlapping = this.getByPosition(event.position);
      for (const e of overlapping) {
        this.touchTable[event.polygonId][e.polygonId] = true;
      }
    }
  }

  getByPosition(position: Position) {
    return this.byPosition[position.join(",")].filter(
      (e) => !this.removedPolygonIds[e.polygonId]
    );
  }

  getByX(position: Position) {
    return this.byX[position[0]].filter(
      (e) => !this.removedPolygonIds[e.polygonId]
    );
  }

  getByY(position: Position) {
    return this.byY[position[1]].filter(
      (e) => !this.removedPolygonIds[e.polygonId]
    );
  }

  getNextExteriorRing(): Event | null {
    let exteriorEvent: Event | null = null;
    for (var i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      if (!this.removedPolygonIds[event.polygonId]) {
        if (!exteriorEvent || event.position[0] < exteriorEvent.position[0]) {
          exteriorEvent = event;
        }
      }
    }
    // Always return the top-left corner of the polygon to avoid problems when
    // starting at the middle of a series of boxes
    //                         -----------------------------------
    //                         |       |                          |
    //                         |       |                          |
    // don't start here --->   x--------                          |
    // hard to prevent diving  |       |                          |
    // into the interior       |       |                          |
    //                         |       |                          |
    //                         ---------                          |
    //                                 |                          |
    //                                 |                          |
    //                                 |                          |
    //                                 ----------------------------
    if (exteriorEvent) {
      // correct situation mentioned above
      const inPlane = this.getByX(exteriorEvent.position);
      if (inPlane.length > 0) {
        exteriorEvent = inPlane.sort(
          (a, b) => b.position[1] - a.position[1]
        )[0];
      }
    }
    return exteriorEvent;
  }

  // Any events part of these polygons will be skipped in get...() functions
  markTouchedPolygonsAsProcessed() {
    for (const key in this.touchedPolygonIds) {
      this.removedPolygonIds[key] = true;
      for (const touching in this.touchTable[key]) {
        this.removedPolygonIds[touching] = true;
      }
    }
    this.touchedPolygonIds = {};
  }

  recordTouchedPolygons(polygonIds: number[]) {
    for (const id of polygonIds) {
      this.touchedPolygonIds[id] = true;
    }
  }

  // Clears removed polygonIds
  resetProcessedState() {
    this.removedPolygonIds = {};
    this.touchedPolygonIds = {};
  }

  getTouchedPolygonIds(): number[] {
    return Object.keys(this.touchedPolygonIds).map((k) => parseInt(k));
  }
}
