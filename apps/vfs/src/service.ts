import {
  NEUTRON_TOOL_AUDIT_METADATA_ONLY,
  NEUTRON_TOOL_VISIBILITY_SAME_APP,
  exposeTool,
  publishAppStateChange,
  type ExposedToolOptions,
  type JsonObject,
  type JsonValue,
  type MsgBusToolContext,
} from "neutron-tools/app";
import {
  exposeAttachmentTool,
  type AttachmentToolContext,
} from "neutron-tools/app_attachments";
import {
  FILES_SERVICE_LIMITS,
  FILES_UI_DOWNLOAD_TOOL,
  FILES_UI_TOOL,
  FILES_UI_TRANSFER_TOOL,
  FilesAuthorityManager,
  FilesToolRuntime,
  assertFilesPersistentEnvironment,
  invocationFromCaller,
  parseFilesResidentBinding,
  type FilesResidentFilePort,
  type FilesResidentBinding,
  type FilesServiceUiAction,
} from "./resident/index.ts";
import { createDefaultFilesResidentPort } from "./resident/vault_bridge.ts";

const STATE_TOPIC = "filesystem";
const ATTACHMENT_NAME = "file";
const BINARY_MEDIA_TYPES = [
  "application/octet-stream",
  "application/vnd.neutron.spreadsheet+json",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/json",
  "application/zip",
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

const pathSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 1_024,
  pattern: "^/",
  description:
    "Absolute Files path. Use /Workspace for private everyday files, /Shared for public files, or /Vault for encrypted files. Any other absolute path resolves under /Workspace; '..' is forbidden.",
};
const PATH_TOOL_GUIDANCE =
  "Workspace is the default. Writing under /Shared publishes the file publicly and requires the Files tile or an owner-authorized Agent Mode turn. /Vault is encrypted and must be unlocked.";
const etagSchema: JsonObject = {
  type: "string",
  pattern: "^[a-f0-9]{64}$",
};
const decimalSchema: JsonObject = {
  type: "string",
  pattern: "^0$|^[1-9][0-9]{0,19}$",
};
const nullableStringSchema: JsonObject = {
  oneOf: [{ type: "string" }, { type: "null" }],
};
const transferIdSchema: JsonObject = {
  type: "string",
  minLength: 1,
  maxLength: 96,
  pattern: "^[A-Za-z0-9_-]+$",
};
const metadataOnly = {
  "neutron:audit": NEUTRON_TOOL_AUDIT_METADATA_ONLY,
} as const;

export type FilesToolExposure = Readonly<{
  expose(
    name: string,
    options: ExposedToolOptions,
    handler: (
      args: JsonObject,
      context: MsgBusToolContext,
    ) => JsonValue | Promise<JsonValue>,
  ): void;
  exposeAttachment: typeof exposeAttachmentTool;
  publish(topic: string, revision: string): Promise<void>;
}>;

const DEFAULT_EXPOSURE: FilesToolExposure = Object.freeze({
  expose: exposeTool,
  exposeAttachment: exposeAttachmentTool,
  publish: (topic, revision) => publishAppStateChange(topic, revision),
});

function createFilesStatePublisher(
  exposure: FilesToolExposure,
): () => void {
  let stateRevision = 0n;
  return () => {
    stateRevision += 1n;
    void exposure.publish(STATE_TOPIC, stateRevision.toString()).catch(() => {
      // State publication is a refresh hint; committed resident/backend state
      // remains authoritative if a tile disconnects during notification.
    });
  };
}

export function installFilesV2Tools<Cursor>(
  port: FilesResidentFilePort<Cursor>,
  binding: {
    installationGeneration(): ReturnType<
      typeof parseFilesResidentBinding
    >["installationUid"];
    lockEpoch(): ReturnType<
      typeof parseFilesResidentBinding
    >["browserOriginAuthorityEpoch"];
  },
  exposure: FilesToolExposure = DEFAULT_EXPOSURE,
  publishStateChange: (() => void) | null = null,
): FilesToolRuntime<Cursor> {
  const runtime = new FilesToolRuntime(port, binding);
  const publishMutation =
    publishStateChange ?? createFilesStatePublisher(exposure);

  exposure.expose(
    "list",
    toolOptions(
      "List Files",
      `List one bounded page of a Files folder. Continue with the opaque cursor when another page is available. ${PATH_TOOL_GUIDANCE}`,
      objectSchema([], {
        path: {
          ...pathSchema,
          description: "Folder path. Defaults to /Workspace.",
        },
        recursive: { type: "boolean", default: false },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: FILES_SERVICE_LIMITS.pageEntries,
          default: FILES_SERVICE_LIMITS.pageEntries,
        },
        cursor: {
          type: "string",
          pattern: "^[a-f0-9]{64}$",
          description:
            "Short-lived opaque continuation bound to this caller session and folder revision.",
        },
      }),
      listOutputSchema,
      ["read"],
    ),
    (args, context) =>
      runtime.list(args, ordinaryInvocation(context)),
  );

  exposure.exposeAttachment(
    FILES_UI_TRANSFER_TOOL,
    {
      title: "Files Tile Upload Chunk",
      description:
        "Tile-only sequential, verified upload into the selected Files root.",
      inputSchema: objectSchema(
        ["transferId", "pass", "ordinal", "final", "totalBytes"],
        {
          transferId: {
            type: "string",
            minLength: 1,
            maxLength: 96,
            pattern: "^[A-Za-z0-9_-]+$",
          },
          pass: { type: "string", enum: ["hash", "encrypt"] },
          ordinal: { type: "integer", minimum: 0 },
          final: { type: "boolean" },
          totalBytes: {
            type: "integer",
            minimum: 0,
            maximum: FILES_SERVICE_LIMITS.tileBinaryBytes,
          },
        },
      ),
      outputSchema: objectSchema(
        [
          "transferId",
          "phase",
          "processedBytes",
          "totalBytes",
          "committed",
          "readyForUpload",
          "entry",
        ],
        {
          transferId: { type: "string" },
          phase: { type: "string" },
          processedBytes: { type: "integer", minimum: 0 },
          totalBytes: { type: "integer", minimum: 0 },
          committed: { type: "boolean" },
          readyForUpload: { type: "boolean" },
          entry: {
            oneOf: [entryOutputSchema, { type: "null" }],
          },
        },
      ),
      annotations: {
        "neutron:effects": ["write"],
        ...metadataOnly,
        "neutron:visibility": NEUTRON_TOOL_VISIBILITY_SAME_APP,
      },
      attachments: {
        version: 1,
        input: {
          name: ATTACHMENT_NAME,
          mediaTypes: ["application/octet-stream"],
          maxBytes: FILES_SERVICE_LIMITS.tileChunkBytes,
          required: true,
        },
      },
    },
    async (args, attachments, context) => {
      assertFilesAttachmentTileCaller(context);
      const attachment = attachments[0]!;
      const result = await runtime.uploadChunk(
        args,
        attachment.data,
        attachmentInvocation(context),
      );
      if (result.committed === true) publishMutation();
      return { value: result };
    },
  );

  exposure.exposeAttachment(
    FILES_UI_DOWNLOAD_TOOL,
    {
      title: "Files Tile Download Chunk",
      description:
        "Tile-only sequential download chunks bound to one reviewed path and etag.",
      inputSchema: objectSchema(
        ["transferId", "path", "ordinal", "etag"],
        {
          transferId: transferIdSchema,
          path: pathSchema,
          ordinal: {
            type: "integer",
            minimum: 0,
            maximum:
              Math.ceil(
                FILES_SERVICE_LIMITS.tileBinaryBytes /
                  FILES_SERVICE_LIMITS.tileChunkBytes,
              ) - 1,
          },
          etag: etagSchema,
        },
      ),
      outputSchema: objectSchema(
        [
          "transferId",
          "path",
          "ordinal",
          "etag",
          "totalBytes",
          "processedBytes",
          "final",
          "entry",
        ],
        {
          transferId: transferIdSchema,
          path: pathSchema,
          ordinal: { type: "integer", minimum: 0 },
          etag: etagSchema,
          totalBytes: {
            type: "integer",
            minimum: 0,
            maximum: FILES_SERVICE_LIMITS.tileBinaryBytes,
          },
          processedBytes: {
            type: "integer",
            minimum: 0,
            maximum: FILES_SERVICE_LIMITS.tileBinaryBytes,
          },
          final: { type: "boolean" },
          entry: entryOutputSchema,
        },
      ),
      annotations: {
        "neutron:effects": ["read"],
        ...metadataOnly,
        "neutron:visibility": NEUTRON_TOOL_VISIBILITY_SAME_APP,
      },
      attachments: {
        version: 1,
        output: {
          name: ATTACHMENT_NAME,
          mediaTypes: ["application/octet-stream"],
          maxBytes: FILES_SERVICE_LIMITS.tileChunkBytes,
          required: true,
        },
      },
    },
    async (args, _attachments, context) => {
      assertFilesAttachmentTileCaller(context);
      const result = await runtime.downloadChunk(
        args,
        attachmentInvocation(context),
      );
      return {
        value: result.value,
        attachments: [
          {
            name: ATTACHMENT_NAME,
            mediaType: "application/octet-stream",
            byteLength: result.data.byteLength,
            data: result.data,
          },
        ],
      };
    },
  );

  exposure.expose(
    "stat",
    toolOptions(
      "Inspect Path",
      `Read metadata for one Files path. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["path"], {
        path: pathSchema,
      }),
      entryOutputSchema,
      ["read"],
    ),
    (args, context) =>
      runtime.stat(args, ordinaryInvocation(context)),
  );

  exposure.expose(
    "read",
    toolOptions(
      "Read Text File",
      `Read one complete strict UTF-8 text file, up to 512 KiB. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["path"], {
        path: pathSchema,
      }),
      objectSchema(
        [...Object.keys(entryProperties), "content"],
        {
          ...entryProperties,
          content: {
            type: "string",
            maxLength: FILES_SERVICE_LIMITS.textBytes,
          },
        },
      ),
      ["read"],
    ),
    (args, context) =>
      runtime.read(args, ordinaryInvocation(context)),
  );

  exposure.exposeAttachment(
    "readBinary",
    {
      title: "Read Binary File",
      description:
        `Read verified file bytes with one app attachment, up to 16 MiB. ${PATH_TOOL_GUIDANCE}`,
      inputSchema: objectSchema(["path"], {
        path: pathSchema,
        ifMatch: etagSchema,
      }),
      outputSchema: entryOutputSchema,
      annotations: {
        "neutron:effects": ["read"],
        ...metadataOnly,
      },
      attachments: {
        version: 1,
        output: {
          name: ATTACHMENT_NAME,
          mediaTypes: ["application/octet-stream"],
          maxBytes: FILES_SERVICE_LIMITS.binaryBytes,
          required: true,
        },
      },
    },
    async (args, _attachments, context) => {
      const result = await runtime.readBinary(
        args,
        attachmentInvocation(context),
      );
      return {
        value: result.value,
        attachments: [
          {
            name: ATTACHMENT_NAME,
            mediaType: "application/octet-stream",
            byteLength: result.data.byteLength,
            data: result.data,
          },
        ],
      };
    },
  );

  exposure.expose(
    "write",
    toolOptions(
      "Write Text File",
      `Create or replace one strict UTF-8 file. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["path", "content"], {
        path: pathSchema,
        content: {
          type: "string",
          maxLength: FILES_SERVICE_LIMITS.textBytes,
        },
        overwrite: { type: "boolean" },
        createParents: { type: "boolean", default: true },
        ifMatch: etagSchema,
        ifNoneMatch: { type: "string", enum: ["*"] },
        mediaType: { type: "string", minLength: 3, maxLength: 128 },
      }),
      writeOutputSchema,
      ["write"],
    ),
    async (args, context) => {
      const result = await runtime.write(args, ordinaryInvocation(context));
      publishMutation();
      return result;
    },
  );

  exposure.exposeAttachment(
    "writeBinary",
    {
      title: "Write Binary File",
      description:
        `Create or replace one binary file from a single app attachment, up to 16 MiB. ${PATH_TOOL_GUIDANCE}`,
      inputSchema: objectSchema(["path", "mediaType"], {
        path: pathSchema,
        mediaType: { type: "string", minLength: 3, maxLength: 128 },
        ifMatch: etagSchema,
        ifNoneMatch: { type: "string", enum: ["*"] },
        createParents: { type: "boolean", default: true },
      }),
      outputSchema: writeOutputSchema,
      annotations: {
        "neutron:effects": ["write"],
        ...metadataOnly,
      },
      attachments: {
        version: 1,
        input: {
          name: ATTACHMENT_NAME,
          mediaTypes: [...BINARY_MEDIA_TYPES],
          maxBytes: FILES_SERVICE_LIMITS.binaryBytes,
          required: true,
        },
      },
    },
    async (args, attachments, context) => {
      const attachment = attachments[0]!;
      const result = await runtime.writeBinary(
        args,
        attachment.data,
        attachment.mediaType,
        attachmentInvocation(context),
      );
      publishMutation();
      return { value: result };
    },
  );

  exposure.expose(
    "writeMany",
    toolOptions(
      "Write Many Text Files",
      `Create or replace up to 20 text files with at most 10 MiB total content. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["files"], {
        files: {
          type: "array",
          minItems: 1,
          maxItems: FILES_SERVICE_LIMITS.batchFiles,
          items: objectSchema(["path", "content"], {
            path: pathSchema,
            content: {
              type: "string",
              maxLength: FILES_SERVICE_LIMITS.textBytes,
            },
            overwrite: { type: "boolean" },
            createParents: { type: "boolean" },
            mediaType: { type: "string", minLength: 3, maxLength: 128 },
          }),
        },
      }),
      objectSchema(["count", "files"], {
        count: {
          type: "integer",
          minimum: 1,
          maximum: FILES_SERVICE_LIMITS.batchFiles,
        },
        files: {
          type: "array",
          maxItems: FILES_SERVICE_LIMITS.batchFiles,
          items: writeOutputSchema,
        },
      }),
      ["write"],
    ),
    async (args, context) => {
      const result = await runtime.writeMany(
        args,
        ordinaryInvocation(context),
      );
      publishMutation();
      return result;
    },
  );

  exposure.expose(
    "append",
    toolOptions(
      "Append Text",
      `Read, edit, and compare-and-swap one bounded text file. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["path", "content"], {
        path: pathSchema,
        content: {
          type: "string",
          minLength: 1,
          maxLength: FILES_SERVICE_LIMITS.textBytes,
        },
        asNewLine: { type: "boolean", default: true },
      }),
      objectSchema(
        [...Object.keys(writeProperties), "appended"],
        {
          ...writeProperties,
          appended: { type: "integer", minimum: 1 },
        },
      ),
      ["write"],
    ),
    async (args, context) => {
      const result = await runtime.append(args, ordinaryInvocation(context));
      publishMutation();
      return result;
    },
  );

  exposure.expose(
    "patch",
    toolOptions(
      "Patch Text",
      `Replace exact text in one bounded file using compare-and-swap. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["path", "oldText", "newText"], {
        path: pathSchema,
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
        replaceAll: { type: "boolean", default: false },
      }),
      objectSchema(
        [...Object.keys(writeProperties), "replacements"],
        {
          ...writeProperties,
          replacements: { type: "integer", minimum: 1 },
        },
      ),
      ["write"],
    ),
    async (args, context) => {
      const result = await runtime.patch(args, ordinaryInvocation(context));
      publishMutation();
      return result;
    },
  );

  exposure.expose(
    "mkdir",
    toolOptions(
      "Create Folder",
      `Create one folder, optionally including missing parents. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["path"], {
        path: pathSchema,
        recursive: { type: "boolean", default: true },
      }),
      mutationOutputSchema,
      ["write"],
    ),
    async (args, context) => {
      const result = await runtime.mkdir(args, ordinaryInvocation(context));
      publishMutation();
      return result;
    },
  );

  exposure.expose(
    "move",
    toolOptions(
      "Move Path",
      `Move or rename one file or folder. Moving between roots verifies the copied destination before removing the source. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["from", "to"], {
        from: pathSchema,
        to: pathSchema,
        overwrite: { type: "boolean", default: false },
      }),
      objectSchema(
        [...Object.keys(mutationProperties), "from", "to"],
        {
          ...mutationProperties,
          from: pathSchema,
          to: pathSchema,
        },
      ),
      ["write"],
    ),
    async (args, context) => {
      const result = await runtime.move(args, ordinaryInvocation(context));
      publishMutation();
      return result;
    },
  );

  exposure.expose(
    "remove",
    toolOptions(
      "Remove Path",
      `Remove one file or folder. Recursive removal is explicit and cleanup remains bounded. ${PATH_TOOL_GUIDANCE}`,
      objectSchema(["path"], {
        path: pathSchema,
        recursive: { type: "boolean", default: false },
      }),
      objectSchema(
        [...Object.keys(mutationProperties), "removed"],
        {
          ...mutationProperties,
          removed: { type: "integer", minimum: 1 },
        },
      ),
      ["write"],
    ),
    async (args, context) => {
      const result = await runtime.remove(args, ordinaryInvocation(context));
      publishMutation();
      return result;
    },
  );

  // Same-app, tile-role control plane. Root placement determines storage and
  // publication policy; this surface retains only Vault lifecycle and active
  // transfer controls.
  exposure.expose(
    FILES_UI_TOOL,
    toolOptions(
      "Files Tile Control",
      "Files tile-session control for Vault setup and active transfers.",
      uiInputSchema,
      uiOutputSchema,
      ["read", "write"],
      true,
    ),
    async (args, context) => {
      assertFilesTileCaller(context);
      const action = parseUiAction(args);
      const result = await runtime.ui(
        action,
        ordinaryInvocation(context),
      );
      if (
        action.action !== "status" &&
        action.action !== "unlock" &&
        action.action !== "lock"
      ) {
        publishMutation();
      }
      return result;
    },
  );

  return runtime;
}

function ordinaryInvocation(context: MsgBusToolContext) {
  return invocationFromCaller(context.caller, {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.agentMode ? { agentMode: true } : {}),
    reportProgress: context.reportProgress,
  });
}

function attachmentInvocation(context: AttachmentToolContext) {
  return invocationFromCaller(context.caller, {
    ...(context.signal ? { signal: context.signal } : {}),
    ...(context.agentMode ? { agentMode: true } : {}),
    reportProgress: context.reportProgress,
  });
}

function assertFilesTileCaller(context: MsgBusToolContext): void {
  if (
    context.caller?.appId !== "files" ||
    context.caller.role !== "tile" ||
    !context.caller.sessionId
  ) {
    throw new Error(
      "Files tile controls require a kernel-attested Files tile session",
    );
  }
}

function assertFilesAttachmentTileCaller(
  context: AttachmentToolContext,
): void {
  if (
    context.caller?.appId !== "files" ||
    context.caller.role !== "tile" ||
    !context.caller.sessionId
  ) {
    throw new Error(
      "Files transfer chunks require a kernel-attested Files tile session",
    );
  }
}

function parseUiAction(args: JsonObject): FilesServiceUiAction {
  switch (args.action) {
    case "status":
      return { action: "status" };
    case "initialize":
    case "unlock":
    case "lock":
    case "rotate":
      return { action: args.action };
    case "upload_begin":
      if (
        typeof args.transferId !== "string" ||
        !/^[A-Za-z0-9_-]{1,96}$/u.test(args.transferId) ||
        typeof args.path !== "string" ||
        typeof args.name !== "string" ||
        typeof args.mediaType !== "string" ||
        !Number.isSafeInteger(args.size) ||
        Number(args.size) < 0 ||
        Number(args.size) > FILES_SERVICE_LIMITS.tileBinaryBytes ||
        args.contentKind !== "binary"
      ) {
        throw new Error("Invalid Files streaming upload request");
      }
      return {
        action: "upload_begin",
        transferId: args.transferId,
        path: args.path,
        name: args.name,
        mediaType: args.mediaType,
        size: Number(args.size),
        contentKind: "binary",
      };
    case "cancel":
    case "retry":
      if (
        typeof args.transferId !== "string" ||
        !/^[A-Za-z0-9_-]{1,96}$/u.test(args.transferId)
      ) {
        throw new Error("Invalid Files transfer id");
      }
      return { action: args.action, transferId: args.transferId };
    default:
      throw new Error("Unknown Files tile action");
  }
}

function toolOptions(
  title: string,
  description: string,
  inputSchema: JsonObject,
  outputSchema: JsonObject,
  effects: readonly ("read" | "write")[],
  sameAppOnly = false,
): ExposedToolOptions {
  return {
    title,
    description,
    inputSchema,
    outputSchema,
    annotations: {
      "neutron:effects": [...effects],
      ...metadataOnly,
      ...(sameAppOnly
        ? {
            "neutron:visibility": NEUTRON_TOOL_VISIBILITY_SAME_APP,
          }
        : {}),
    },
  };
}

function objectSchema(
  required: readonly string[],
  properties: JsonObject,
): JsonObject {
  return {
    type: "object",
    required: [...required],
    properties,
    additionalProperties: false,
  };
}

const entryProperties = {
  path: pathSchema,
  name: { type: "string", maxLength: 400 },
  type: { type: "string", enum: ["file", "folder"] },
  storageClass: {
    type: "string",
    enum: ["shared", "vault", "workspace"],
  },
  contentKind: {
    type: ["string", "null"],
    enum: ["text", "binary", null],
  },
  byteLength: { type: ["integer", "null"], minimum: 0 },
  mediaType: nullableStringSchema,
  etag: {
    oneOf: [etagSchema, { type: "null" }],
  },
  publicUrl: nullableStringSchema,
  createdAtNs: decimalSchema,
  modifiedAtNs: decimalSchema,
  revision: decimalSchema,
} satisfies JsonObject;

const entryOutputSchema = objectSchema(
  Object.keys(entryProperties),
  entryProperties,
);

const writeProperties = {
  ...entryProperties,
  cleanupPending: { type: "boolean" },
} satisfies JsonObject;

const writeOutputSchema = objectSchema(
  Object.keys(writeProperties),
  writeProperties,
);

const mutationProperties = {
  path: pathSchema,
  revision: decimalSchema,
  changed: { type: "integer", minimum: 0 },
  cleanupPending: { type: "boolean" },
} satisfies JsonObject;

const mutationOutputSchema = objectSchema(
  Object.keys(mutationProperties),
  mutationProperties,
);

const listOutputSchema = objectSchema(
  [
    "path",
    "revision",
    "loaded",
    "total",
    "hasMore",
    "cursor",
    "entries",
  ],
  {
    path: pathSchema,
    revision: decimalSchema,
    loaded: { type: "integer", minimum: 0 },
    total: { type: "integer", minimum: 0 },
    hasMore: { type: "boolean" },
    cursor: {
      oneOf: [
        { type: "string", pattern: "^[a-f0-9]{64}$" },
        { type: "null" },
      ],
    },
    entries: {
      type: "array",
      maxItems: FILES_SERVICE_LIMITS.pageEntries,
      items: entryOutputSchema,
    },
  },
);

const uiInputSchema: JsonObject = {
  ...objectSchema(["action"], {
    action: {
      type: "string",
      enum: [
        "status",
        "initialize",
        "unlock",
        "lock",
        "rotate",
        "upload_begin",
        "cancel",
        "retry",
      ],
    },
    path: pathSchema,
    transferId: {
      type: "string",
      minLength: 1,
      maxLength: 96,
      pattern: "^[A-Za-z0-9_-]+$",
    },
    name: { type: "string", minLength: 1, maxLength: 400 },
    mediaType: { type: "string", minLength: 3, maxLength: 128 },
    size: {
      type: "integer",
      minimum: 0,
      maximum: FILES_SERVICE_LIMITS.tileBinaryBytes,
    },
    contentKind: { type: "string", enum: ["binary"] },
  }),
  allOf: [
    {
      if: {
        properties: { action: { const: "upload_begin" } },
        required: ["action"],
      },
      then: {
        required: ["transferId", "path", "name", "mediaType", "size", "contentKind"],
      },
    },
  ],
};

const uiOutputSchema: JsonObject = {
  type: "object",
  description:
    "Closed action-specific Files tile result. Workspace and Shared remain available while Vault is unavailable.",
};

async function startDefaultResident(): Promise<void> {
  // Construction is synchronous and inert. Register the tools in this module
  // evaluation turn so a freshly connected tile cannot observe an empty
  // resident tool table.
  const port = createDefaultFilesResidentPort();
  const controller = startFilesResident(port, {
    href: window.location.href,
    environment: window as Window & { credentialless?: boolean },
  });
  const refreshAuthority = (): void => {
    try {
      controller.refreshAuthority(window.location.href);
    } catch {
      controller.shutdown();
    }
  };
  const visibility = (): void => {
    if (document.visibilityState === "visible") refreshAuthority();
  };
  window.addEventListener("focus", refreshAuthority);
  window.addEventListener("pageshow", refreshAuthority);
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener(
    "pagehide",
    () => {
      window.removeEventListener("focus", refreshAuthority);
      window.removeEventListener("pageshow", refreshAuthority);
      document.removeEventListener("visibilitychange", visibility);
      controller.shutdown();
    },
    { once: true },
  );
}

export type FilesResidentController = Readonly<{
  runtime: FilesToolRuntime<unknown>;
  binding(): FilesResidentBinding | null;
  refreshAuthority(href: string, authorizedPrincipal?: string | null): void;
  shutdown(): void;
}>;

export function startFilesResident(
  port: FilesResidentFilePort,
  options: {
    href: string;
    environment: { credentialless?: boolean };
    authorizedPrincipal?: string | null;
    exposure?: FilesToolExposure;
  },
): FilesResidentController {
  assertFilesPersistentEnvironment(options.environment);
  const initial = parseFilesResidentBinding(
    options.href,
    options.authorizedPrincipal ?? null,
  );
  const exposure = options.exposure ?? DEFAULT_EXPOSURE;
  const publishStateChange = createFilesStatePublisher(exposure);
  let authority: FilesAuthorityManager | null = null;
  const runtime = installFilesV2Tools(
    port,
    {
      installationGeneration: () =>
        authority?.binding?.installationUid ?? initial.installationUid,
      lockEpoch: () =>
        authority?.lockEpoch ?? initial.browserOriginAuthorityEpoch,
    },
    exposure,
    publishStateChange,
  ) as FilesToolRuntime<unknown>;
  authority = new FilesAuthorityManager({
    // The high-level port owns metadata, worker, transfer, and crypto-buffer
    // erasure as one atomic volatile boundary. Do it exactly once per reset;
    // the remaining callbacks clear service/tile-owned state only.
    clearMetadata: (reason) => port.clearVolatile(reason),
    clearContinuations: () => runtime.clearContinuations(),
    cancelTransfers: () => {},
    revokeBlobUrls: () => {},
    dropDirtyBuffers: () => {},
    lockWorker: () => {},
  });
  authority.adopt(initial);
  let closed = false;
  let handlingPortLock = false;
  const unsubscribeLock =
    port.onLock?.((reason) => {
      if (closed || handlingPortLock) return;
      handlingPortLock = true;
      try {
        authority?.relock(
          reason === "worker_failure"
            ? "worker_failure"
            : "lock_epoch_changed",
        );
      } finally {
        handlingPortLock = false;
      }
    }) ?? (() => undefined);
  const unsubscribeStatusChange =
    port.onStatusChange?.(() => publishStateChange()) ??
    port.onLock?.(() => publishStateChange()) ??
    (() => undefined);
  return Object.freeze({
    runtime,
    binding: () => authority?.binding ?? null,
    refreshAuthority(href, authorizedPrincipal = null) {
      if (closed) throw new Error("Files resident controller is closed");
      authority?.adopt(
        parseFilesResidentBinding(href, authorizedPrincipal),
      );
    },
    shutdown() {
      if (closed) return;
      closed = true;
      unsubscribeStatusChange();
      unsubscribeLock();
      authority?.shutdown();
      runtime.clear();
      authority = null;
    },
  });
}

if (typeof window !== "undefined") {
  void startDefaultResident().catch(() => {
    // Never emit dynamic resident errors: they can contain private paths or
    // plaintext supplied by a tool caller. A constant refresh hint lets an
    // already-connected tile surface its fixed unavailable state instead.
    void publishAppStateChange(STATE_TOPIC, "0").catch(() => {
      // The resident remains failed closed if no tile is connected.
    });
  });
}
