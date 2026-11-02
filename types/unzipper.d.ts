// Minimal types for the parts of unzipper used by lib/xlsx-reorder.ts.
declare module "unzipper" {
  import type { Readable } from "node:stream"

  type CentralDirectoryFile = {
    path: string
    offsetToLocalFileHeader: number
    compressedSize: number
    uncompressedSize: number
  }

  type CentralDirectory = {
    files: CentralDirectoryFile[]
    offsetToStartOfCentralDirectory: number
  }

  const unzipper: {
    Open: {
      custom(source: {
        size(): Promise<number>
        stream(offset: number, length?: number): Readable
      }): Promise<CentralDirectory>
    }
  }
  export default unzipper
}
