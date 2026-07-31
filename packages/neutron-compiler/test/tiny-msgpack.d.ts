declare module "tiny-msgpack" {
  const msgpack: {
    encode(value: unknown): Uint8Array;
    decode(value: Uint8Array): unknown;
  };

  export default msgpack;
}
