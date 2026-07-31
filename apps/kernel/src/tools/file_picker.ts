export async function pickFile({ accept = ".neutron" } = {}): Promise<File> {
  return new Promise((resolve, reject) => {
    const inputElement = document.createElement("input");
    inputElement.style.display = "none";
    inputElement.type = "file";
    inputElement.accept = accept;

    const cleanup = () => {
      inputElement.removeEventListener("change", onChange);
      inputElement.removeEventListener("cancel", onCancel);
      setTimeout(() => {
        inputElement.remove();
      }, 1000);
    };

    const finish = (callback: () => void) => {
      cleanup();
      callback();
    };

    function onChange(): void {
      if (inputElement.files?.[0]) {
        const file = inputElement.files[0];
        finish(() => resolve(file));
        return;
      }
      finish(() => reject(new Error("File picker cancelled")));
    }

    function onCancel(): void {
      finish(() => reject(new Error("File picker cancelled")));
    }

    inputElement.addEventListener("change", onChange);
    inputElement.addEventListener("cancel", onCancel);

    document.body.appendChild(inputElement);
    inputElement.click();
  });
}

export function readFile(file: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.addEventListener("loadend", () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }
      reject(new Error("Expected file picker result to be an ArrayBuffer"));
    });
    reader.addEventListener("error", reject);

    reader.readAsArrayBuffer(file);
  });
}
