export function inferContentType(fileName: string): string {
  const ext = fileName.toLowerCase().split(".").pop();
  switch (ext) {
    case "pdf":  return "application/pdf";
    case "png":  return "image/png";
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    case "heic": return "image/heic";
    case "tiff":
    case "tif":  return "image/tiff";
    default:     return "application/octet-stream";
  }
}
