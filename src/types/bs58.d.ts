declare module 'bs58' {
  const bs58: {
    encode(buffer: Uint8Array): string;
    decode(str: string): Buffer;
    decodeUnsafe(str: string): Buffer | undefined;
  };
  export = bs58;
}
