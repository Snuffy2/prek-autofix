import packageMetadata from "../../../package.json";

/** Return the version banner shown at the start of each action run. */
export function versionBanner(): string {
  return `prek-autofix version v${packageMetadata.version}`;
}
