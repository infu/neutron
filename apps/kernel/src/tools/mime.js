export function mime(filename) {
  // Retrieve file extension
  let extension = filename.split(".").pop().toLowerCase();

  // Define popular file types
  let types = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    bmp: "image/bmp",
    webp: "image/webp",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    html: "text/html",
    css: "text/css",
    js: "application/javascript",
    json: "application/json",
    xml: "application/xml",
    txt: "text/plain",
    md: "text/markdown",
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    mp3: "audio/mpeg",
    wav: "audio/wav",
  };

  // Find the mime type in the dictionary. If not found, return 'application/octet-stream' as default
  return types[extension] || "application/octet-stream";
}
