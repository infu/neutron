export async function pickFile() {
  return new Promise((resolve, reject) => {
    const inputElemenet = document.createElement("input");
    inputElemenet.style.display = "none";
    inputElemenet.type = "file";

    inputElemenet.addEventListener("change", () => {
      if (inputElemenet.files) {
        resolve(inputElemenet.files[0]);
      }
    });

    const teardown = () => {
      reject(new Error("File picker cancelled"));
      document.body.removeEventListener("focus", teardown, true);
      setTimeout(() => {
        document.body.removeChild(inputElemenet);
      }, 1000);
    };

    document.body.addEventListener("focus", teardown, true);

    document.body.appendChild(inputElemenet);
    inputElemenet.click();
  });
}

export function readFile(file) {
  return new Promise((resolve, reject) => {
    // Create file reader
    let reader = new FileReader();

    // Register event listeners
    reader.addEventListener("loadend", (e) => resolve(e.target.result));
    reader.addEventListener("error", reject);

    // Read file
    reader.readAsArrayBuffer(file);
  });
}
