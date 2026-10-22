export interface OmpArtifactManifest {
  schemaVersion: 1;
  version: string;
  commit: string;
  protocolBaseline: string;
  target: string;
  executable: string;
  files: Record<string, string>;
}
export const OMP_PROTOCOL_BASELINE: string;
export const OMP_ARTIFACT_MANIFEST: string;
export function verifyOmpArtifact(
  root: string,
  target: string,
): Promise<{ command: string; manifest: OmpArtifactManifest }>;
export function stageOmpArtifact(options: {
  sourceRoot?: string;
  destination: string;
  target: string;
}): Promise<{ command: string; manifest: OmpArtifactManifest }>;
