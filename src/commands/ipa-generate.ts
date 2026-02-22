import { resolveIpaArtifact, type IpaSource } from "../ipa/artifact.js";
import {
  autoDetectIpaGenerateSource,
  createDefaultOutputIpaPath
} from "../ipa/autodetect.js";
import { verifyIpa } from "../ipa/preflight.js";

export async function ipaGenerateCommand(command: {
  readonly outputIpaPath?: string;
  readonly ipaSource?: Exclude<IpaSource, { kind: "prebuilt" }>;
  readonly json: boolean;
}): Promise<number> {
  const cwd = process.cwd();
  const resolvedSource =
    command.ipaSource ?? (await autoDetectIpaGenerateSource({ cwd }));
  const outputIpaPath = command.outputIpaPath ?? createDefaultOutputIpaPath(resolvedSource, cwd);
  const sourceWithOutputPath: Exclude<IpaSource, { kind: "prebuilt" }> = {
    ...resolvedSource,
    outputIpaPath
  };

  const artifact = await resolveIpaArtifact(sourceWithOutputPath);

  try {
    const report = await verifyIpa({ ipaPath: artifact.ipaPath });

    if (command.json) {
      console.log(
        JSON.stringify(
          {
            outputIpaPath,
            report
          },
          null,
          2
        )
      );
    } else {
      console.log(`Generated IPA: ${outputIpaPath}`);
      console.log(`Bundle ID: ${report.bundleId ?? "unknown"}`);
      console.log(`Version: ${report.version ?? "unknown"} (${report.buildNumber ?? "unknown"})`);
      console.log(`SHA-256: ${report.sha256 ?? "unavailable"}`);
      console.log(`Signing validated: ${report.signingValidated ? "yes" : "no"}`);
    }

    if (report.errors.length > 0) {
      report.errors.forEach((line) => console.error(`- ${line}`));
      return 1;
    }

    return 0;
  } finally {
    if (artifact.dispose) {
      await artifact.dispose();
    }
  }
}
