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
  appsReadMetadataCommand,
  readMetadata,
  type AppsReadMetadataInput,
  type AppsReadMetadataResult
} from "./commands/apps-read-metadata.js";
export {
  appsUpdateMetadataCommand,
  selectEditableAppInfo,
  updateMetadata,
  type AgeRatingDeclaration,
  type AppInfoCandidate,
  type AppMetadata,
  type EditableVersion,
  type MetadataManifest,
  type MetadataLocale,
  type MetadataUpdateInput,
  type MetadataUpdateResult,
  type ReviewContact
} from "./commands/apps-update-metadata.js";
export {
  appsCreateVersionCommand,
  createAppStoreVersion,
  type AppStorePlatform,
  type CreateAppStoreVersionInput,
  type CreateVersionCommandResult,
  type CreatedAppStoreVersion
} from "./commands/apps-create-version.js";
export { analyticsSetupCommand } from "./commands/analytics-setup.js";
export { analyticsFetchCommand } from "./commands/analytics-fetch.js";
export { analyticsSummaryCommand } from "./commands/analytics-summary.js";
export { salesFetchCommand } from "./commands/sales-fetch.js";
export { ranksCheckCommand } from "./commands/ranks-check.js";
export {
  fetchAnalytics,
  type FetchAnalyticsInput,
  type FetchAnalyticsResult
} from "./analytics/fetch.js";
export {
  setupAnalytics,
  type AnalyticsSetupResult
} from "./analytics/requests.js";
export {
  summarizeDay,
  type DailyKpi
} from "./analytics/metrics.js";
export { fetchSalesReport, type SalesReport } from "./sales/sales-report.js";
export { checkRanks, type RankRow } from "./ranks/itunes-search.js";
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
  type AnalyticsFetchCliCommand,
  type AnalyticsSetupCliCommand,
  type AnalyticsSummaryCliCommand,
  type AppsCreateVersionCliCommand,
  type AppsListCliCommand,
  type AppsReadMetadataCliCommand,
  type AppsUpdateMetadataCliCommand,
  type BuildsUploadCliCommand,
  type CliCommand,
  type CertificatesCreateCliCommand,
  type HelpCliCommand,
  type IpaExportOptionsCliCommand,
  type IpaGenerateCliCommand,
  type RanksCheckCliCommand,
  type SalesFetchCliCommand
} from "./cli.js";
