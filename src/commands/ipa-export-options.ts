import { access, constants, mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { InfrastructureError } from "../api/client.js";
import { createExportOptionsPlist, type SigningStyle } from "../ipa/signing.js";

export interface IpaExportOptionsCommandInput {
  readonly json: boolean;
  readonly outputPlistPath?: string;
  readonly teamId?: string;
  readonly signingStyle?: SigningStyle;
  readonly force: boolean;
}

export async function ipaExportOptionsCommand(
  command: IpaExportOptionsCommandInput
): Promise<number> {
  const outputPlistPath = path.resolve(command.outputPlistPath ?? "./ExportOptions.plist");
  const signingStyle = command.signingStyle ?? "automatic";
  const teamId = command.teamId?.trim();

  if (!command.force) {
    const exists = await access(outputPlistPath, constants.F_OK)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      throw new InfrastructureError(
        [
          `Export options plist already exists: ${outputPlistPath}`,
          "Use --force to overwrite."
        ].join(" ")
      );
    }
  }

  await mkdir(path.dirname(outputPlistPath), { recursive: true });

  const plistContents = createExportOptionsPlist({
    signingStyle,
    ...(teamId ? { teamId } : {})
  });

  await writeFile(outputPlistPath, plistContents, "utf8");

  if (command.json) {
    console.log(
      JSON.stringify(
        {
          outputPlistPath,
          method: "app-store",
          destination: "export",
          signingStyle,
          ...(teamId ? { teamId } : {})
        },
        null,
        2
      )
    );
  } else {
    console.log(`Generated ExportOptions.plist: ${outputPlistPath}`);
    console.log("method=app-store (TestFlight/App Store)");
    console.log(`signingStyle=${signingStyle}`);
    console.log(`teamID=${teamId ?? "from archive defaults"}`);
  }

  return 0;
}
