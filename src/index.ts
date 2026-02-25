// API client
export {
  AppStoreConnectClient,
  DomainError,
  InfrastructureError,
  type AppStoreConnectAuthConfig,
  type Clock,
  type FetchLike,
  type HttpMethod,
  type HttpQueryValue,
  type HttpRequest,
  type HttpResponse
} from "./api/client.js";

// Upload operations
export {
  executeUploadOperations,
  parseUploadOperations,
  type UploadFetchLike,
  type UploadHttpHeader,
  type UploadOperation
} from "./api/types.js";

// Commands
export { appsListCommand, listApps, type AppSummary } from "./commands/apps-list.js";
export {
  appsUpdateMetadataCommand,
  updateMetadata,
  type MetadataManifest,
  type MetadataLocale,
  type MetadataUpdateInput,
  type MetadataUpdateResult
} from "./commands/apps-update-metadata.js";
export {
  buildsUploadCommand,
  uploadBuild,
  type BuildsUploadInput,
  type BuildsUploadResult
} from "./commands/builds-upload.js";
export {
  certificatesCreateCommand,
  type CertificatesCreateCommandInput
} from "./commands/certificates-create.js";
export {
  ipaExportOptionsCommand,
  type IpaExportOptionsCommandInput
} from "./commands/ipa-export-options.js";
export { ipaGenerateCommand } from "./commands/ipa-generate.js";

// IPA utilities
export {
  resolveIpaArtifact,
  type CustomCommandIpaSource,
  type IpaArtifact,
  type IpaSource,
  type PrebuiltIpaSource,
  type ProcessRunner,
  type XcodebuildIpaSource
} from "./ipa/artifact.js";
export { SigningError } from "./ipa/signing.js";
export {
  verifyIpa,
  type IpaPreflightReport,
  type VerifyStrictIpaInput
} from "./ipa/preflight.js";

// CLI
export {
  parseCliCommand,
  resolveCliEnvironment,
  runCli,
  type AppsListCliCommand,
  type AppsUpdateMetadataCliCommand,
  type BuildsUploadCliCommand,
  type CliCommand,
  type CertificatesCreateCliCommand,
  type HelpCliCommand,
  type IpaExportOptionsCliCommand,
  type IpaGenerateCliCommand
} from "./cli.js";
