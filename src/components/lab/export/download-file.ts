/**
 * Saves text as a file through a Blob URL and a link with the `download` attribute. A download
 * is neither a script, a frame nor a fetch, so the strict Content-Security-Policy has no
 * directive that applies to it: `blob:` needs no entry anywhere (e2e/lab-export.spec.ts holds
 * that against the production policy).
 */
export interface DownloadableFile {
  readonly name: string;
  readonly mediaType: string;
  readonly content: string;
}

export function downloadFile(file: DownloadableFile): void {
  const url = URL.createObjectURL(new Blob([file.content], { type: file.mediaType }));
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
