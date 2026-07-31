export type BinaryFileMetadata = {
  path: string;
  mediaType: string;
  byteLength: number;
  etag: string;
  updatedAt?: number;
};

export type BinaryFileRead = BinaryFileMetadata & { data: ArrayBuffer };

/**
 * The resident depends on this capability, never on a concrete VFS transport.
 * The Neutron attachment adapter can implement it without exposing bytes to JSON.
 */
export interface WorkbookFilesPort {
  readBinary(path: string, options?: { ifMatch?: string; delegationToken?: string }): Promise<BinaryFileRead>;
  writeBinary(
    path: string,
    mediaType: string,
    data: ArrayBuffer,
    condition: { ifMatch: string } | { ifNoneMatch: "*" },
    options?: { delegationToken?: string },
  ): Promise<BinaryFileMetadata>;
}

export interface XlsxCodecPort {
  import(data: ArrayBuffer): Promise<{ workbook: import("./model.ts").SpreadsheetWorkbook; warnings: string[] }>;
  export(workbook: import("./model.ts").SpreadsheetWorkbook): Promise<{
    data: ArrayBuffer;
    warnings: string[];
    losses?: Record<string, number>;
  }>;
}

export class UnavailableFilesPort implements WorkbookFilesPort {
  async readBinary(): Promise<never> {
    throw new FilePortError("ATTACHMENT_API_REQUIRED", "Binary Files integration is not available in this runtime");
  }
  async writeBinary(): Promise<never> {
    throw new FilePortError("ATTACHMENT_API_REQUIRED", "Binary Files integration is not available in this runtime");
  }
}

export class FilePortError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "FilePortError";
  }
}
