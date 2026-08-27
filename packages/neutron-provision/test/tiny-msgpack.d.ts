declare module "tiny-msgpack" {
  const msgpack: {
    encode(value: unknown): Uint8Array;
  };

  export default msgpack;
}
