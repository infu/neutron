import msgpack from "tiny-msgpack";
import plimit from "p-limit";
import { mime } from "./mime.js";
import { hashContent } from "neutron-tools/src/hash.js";
import { gunzipSync, gzipSync } from "fflate";

export function unpack(pkg) {
  let unpacked = msgpack.decode(pkg);
  return unzipObject(unpacked);
}

async function unzipObject(obj) {
  const newObj = { ...obj };

  for (let key in newObj) {
    if (newObj[key]) {
      newObj[key] = gunzipSync(newObj[key]);
    }
  }
  return newObj;
}

export const chunkfile = (ua) => {
  let size = ua.length;
  let chunkSize = 1024 * 1024;
  let chunks = Math.ceil(size / chunkSize);
  let r = [];
  for (let i = 0; i < chunks; i++) {
    r.push(ua.slice(i * chunkSize, (i + 1) * chunkSize));
  }
  return r;
};

export async function prepare_files(pkg, mo_prefix, app_prefix) {
  let files = pkg;

  // files convert to array
  files = Object.keys(files).map((x) => ({ path: x, content: files[x] }));

  // prefix all files with app_prefix
  for (let f of files) {
    if (f.path.indexOf("web/") === 0) {
      f.path = f.path.replace("web/", app_prefix);
    } else if (f.path.indexOf("mo/") === 0) {
      let hash = hashContent(f.content);
      let expected = "mo/" + hash + ".mo";
      if (f.path !== expected) {
        throw new Error(`Invalid mo hash ${expected} != ${f.path}`);
      }
      f.path = f.path.replace("mo/", mo_prefix);
    } else {
      f.path = app_prefix + "pkg/" + f.path;
    }
  }

  return files;
}

export async function upload_files(neutron, files) {
  const limit = plimit(30); // Max concurrent requests

  await Promise.all(
    files.map(async ({ path, content }) =>
      limit(async () => {
        const filebin = content;

        let content_type = mime(path);
        if (!content_type) content_type = "application/octet-stream";
        const content_encoding =
          content_type.indexOf("image/") === -1 ? "gzip" : "identity"; // not sure why plain binary is called 'identity'?
        const processed_file =
          content_encoding === "gzip" ? gzipSync(filebin) : filebin;

        const chunks = chunkfile(processed_file);
        let key = "/" + (path === "index.html" ? "" : path);

        await neutron.kernel_static({
          store: {
            key,
            val: {
              content: chunks[0],
              content_type,
              content_encoding,
              chunks: chunks.length,
            },
          },
        });

        for (let i = 1; i < chunks.length; i++) {
          await neutron.kernel_static({
            store_chunk: {
              key,
              content: chunks[i],
              chunk_id: i,
            },
          });
        }

        console.log("Uploaded ", path);
      })
    )
  ).then((x) => x.flat());
}
