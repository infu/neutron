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

export async function prepare_files(
  neutron,
  pkg,
  name,
  mo_prefix,
  app_prefix,
  neutron_canister_id
) {
  let files = pkg;

  // files convert to array
  files = Object.keys(files).map((x) => ({ path: x, content: files[x] }));

  // prefix all files with app_prefix
  for (let f of files) {
    if (f.path.indexOf("dist/web/") === 0) {
      f.path = f.path.replace("dist/web/", app_prefix);
      const ext = f.path.split(".").pop();
      if (ext === "js") {
        let tmp = new TextDecoder().decode(f.content);
        tmp = tmp.replace(
          /"NEUTRON_ENV_CANISTER_ID"/gs,
          `"${neutron_canister_id}"`
        );
        f.content = new TextEncoder().encode(tmp);
      }
    } else if (f.path.indexOf("dist/mo/") === 0) {
      let hash = hashContent(f.content);
      let expected = "dist/mo/" + hash + ".mo";
      if (f.path !== expected) {
        throw new Error(`Invalid mo hash ${expected} != ${f.path}`);
      }
      f.path = f.path.replace("dist/mo/", mo_prefix);
    } else {
      f.path = app_prefix + "pgk/" + f.path;
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
          content_type.indexOf("image/") === -1 ? "gzip" : "plain"; // not sure why plain binary is called 'identity'?
        const processed_file =
          content_encoding === "gzip" ? gzipSync(filebin) : filebin;

        const chunks = chunkfile(processed_file);

        await neutron.kernel_static({
          store: {
            key: "/" + (path === "index.html" ? "" : path),
            val: {
              content: chunks[0],
              content_type,
              content_encoding,
            },
          },
        });
        console.log("Uploaded ", path);
      })
    )
  ).then((x) => x.flat());
}
