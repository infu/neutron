export type WhitelistEntry = {
  path: string;
  text: Array<{ line: number; code: string }>;
  ast: string[];
};

export const whitelist: Record<string, WhitelistEntry> = {
  "ccb23e2d72bb4ab9edc842d7dc106d708734b3a441117e4a7816067209391eac": {
    "path": ".mops/_github/core#v2.6.0/src/Runtime.mo",
    "text": [
      {
        "line": 9,
        "code": "systemCapability"
      },
      {
        "line": 9,
        "code": "systemEnvironment"
      }
    ],
    "ast": [
      "systemCapability",
      "systemEnvironment"
    ]
  },
  "52a7c600886416b0c0d29373b0cc53a9f47ee2a65dce6950ca2e546341f9fc8d": {
    "path": ".mops/_github/core#v2.6.0/src/Principal.mo",
    "text": [
      {
        "line": 13,
        "code": "actor"
      },
      {
        "line": 14,
        "code": "actorOfPrincipal"
      }
    ],
    "ast": [
      "actor",
      "actorOfPrincipal"
    ]
  }
};
