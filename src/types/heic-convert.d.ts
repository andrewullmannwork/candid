declare module "heic-convert" {
  interface ConvertOptions {
    buffer: Uint8Array | ArrayBuffer;
    format: "JPEG" | "PNG";
    quality?: number;
  }
  export default function convert(options: ConvertOptions): Promise<Uint8Array>;
}
