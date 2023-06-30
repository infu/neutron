export const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    id: {
      type: "string",
      minLength: 3,
      maxLength: 30,
      pattern: "^[a-zA-Z_0-9]*$",
    },
    name: {
      type: "string",
      minLength: 3,
      maxLength: 20,
      pattern: "^[a-zA-Z0-9s]*$",
    },
    version: {
      type: "integer",
      minimum: 1,
    },
    src: {
      type: "string",
      minLength: 2,
      maxLength: 30,
    },
    entry: {
      type: "string",
      pattern: "^[a-zA-Z0-9]*$",
    },
    init_arg: {
      type: "array",
      items: {
        type: "string",
        pattern: "^[a-zA-Z_0-9.]*$",
      },
    },
    func: {
      type: "object",
      patternProperties: {
        "^[a-zA-Z_0-9]*$": {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["update", "query", "internal"],
            },
            allow: {
              type: "string",
            },
            async: {
              type: "boolean",
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
    memory: {
      type: "object",
      patternProperties: {
        "^[a-zA-Z_0-9]*$": {
          type: "object",
          properties: {
            version: {
              type: "integer",
              minimum: 1,
            },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  required: ["id", "name", "version"],
  additionalProperties: false,
};
