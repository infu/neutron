import { createRxDatabase } from "rxdb";

import { addRxPlugin } from "rxdb";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
addRxPlugin(RxDBDevModePlugin);
import { RxDBJsonDumpPlugin } from "rxdb/plugins/json-dump";
addRxPlugin(RxDBJsonDumpPlugin);
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";
import { RxDBAttachmentsPlugin } from "rxdb/plugins/attachments";
addRxPlugin(RxDBAttachmentsPlugin);

import { unpack } from "./tools/install";

export const db = await createRxDatabase({
  name: "heroesdb", // <- name
  storage: getRxStorageDexie(), // <- RxStorage
  password: "myPassword", // <- password (optional)
  multiInstance: true, // <- multiInstance (optional, default: true)
  eventReduce: true, // <- eventReduce (optional, default: false)
  cleanupPolicy: {}, // <- custom cleanup policy (optional)
});

// db.exportJSON().then((json) => console.dir(json));

db.$.subscribe((changeEvent) => console.dir(changeEvent));

const mySchema = {
  title: "hero schema",
  version: 0,
  description: "describes a simple hero",
  primaryKey: "name",
  type: "object",
  properties: {
    name: {
      type: "string",
      maxLength: 100, // <- the primary key must have set maxLength
    },
    color: {
      type: "string",
    },
    healthpoints: {
      type: "number",
      minimum: 0,
      maximum: 100,
    },
    secret: {
      type: "string",
    },
    birthyear: {
      type: "number",
      final: true,
      minimum: 1900,
      maximum: 2050,
    },
    skills: {
      type: "array",
      maxItems: 5,
      uniqueItems: true,
      items: {
        type: "object",
        properties: {
          name: {
            type: "string",
          },
          damage: {
            type: "number",
          },
        },
      },
    },
  },
  required: ["name", "color"],
};

await db.addCollections({
  heroes: {
    schema: mySchema,
  },
});

// await db.heroes.insert({
//   name: "foo2",
//   color: "blue",
// });

await db.heroes.exportJSON().then((json) => console.dir(json));
