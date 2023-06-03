export async function pickFile({ accept = ".neutron" } = {}) {
  return new Promise((resolve, reject) => {
    const inputElement = document.createElement("input");
    inputElement.style.display = "none";
    inputElement.type = "file";
    inputElement.accept = accept;

    inputElement.addEventListener("change", () => {
      if (inputElement.files) {
        resolve(inputElement.files[0]);
      }
    });

    const teardown = () => {
      reject(new Error("File picker cancelled"));
      document.body.removeEventListener("focus", teardown, true);
      setTimeout(() => {
        document.body.removeChild(inputElement);
      }, 1000);
    };

    document.body.addEventListener("focus", teardown, true);

    document.body.appendChild(inputElement);
    inputElement.click();
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
