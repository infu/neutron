declare module "js-sha256" {
  type Hashable =
    | string
    | ArrayBuffer
    | Uint8Array
    | ArrayLike<number>;

  export const sha256: {
    create(): {
      update(content: Hashable): void;
      hex(): string;
    };
    (content: Hashable): string;
  };
}
