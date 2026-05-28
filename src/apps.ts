import { getCollectorForMachine, listKnownMachineIds, type Collector } from "./collectors/index.js";

const INSTALLED_APPS_COMMAND = `
found=0
os="$(uname -s 2>/dev/null || echo unknown)"

if [ "$os" = "Darwin" ]; then
  if command -v brew >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=brew-formula"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      name="\${line%% *}"
      versions="\${line#"$name"}"
      versions="\${versions# }"
      owner=""
      root_owned=0
      prefix="$(brew --prefix "$name" 2>/dev/null || true)"
      if [ -n "$prefix" ] && [ -e "$prefix" ]; then
        owner="$(stat -f '%Su' "$prefix" 2>/dev/null || stat -c '%U' "$prefix" 2>/dev/null || true)"
        if [ "$owner" = "root" ]; then
          root_owned=1
        fi
      fi
      printf '%s\t%s\t%s\t%s\n' "$name" "$versions" "$owner" "$root_owned"
    done < <(brew list --versions 2>/dev/null)

    echo "__SECTION__=brew-cask"
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      name="\${line%% *}"
      versions="\${line#"$name"}"
      versions="\${versions# }"
      printf '%s\t%s\t%s\t%s\n' "$name" "$versions" "" "0"
    done < <(brew list --cask --versions 2>/dev/null)
  fi
else
  if command -v dpkg-query >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=dpkg"
    dpkg-query -W -f='\${Package}\t\${Version}\n' 2>/dev/null
  fi
  if command -v snap >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=snap"
    snap list 2>/dev/null | awk 'NR > 1 && $1 != "" { print $1 "\t" $2 }'
  fi
  if command -v flatpak >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=flatpak"
    flatpak list --columns=application,version 2>/dev/null | awk 'NF >= 1 { print $1 "\t" $2 }'
  fi
fi

if [ "$found" -eq 0 ]; then
  echo "__SECTION__=none"
  exit 127
fi
`.trim();

export interface InstalledApp {
  name: string;
  version: string | null;
  manager: "brew" | "dpkg" | "snap" | "flatpak";
  kind: "formula" | "cask" | "package";
  owner: string | null;
  rootOwned: boolean;
}

export interface InstalledAppsResult {
  machineId: string;
  ok: boolean;
  apps: InstalledApp[];
  error?: string;
}

export interface AppComparison {
  packageKey: string;
  name: string;
  manager: InstalledApp["manager"];
  kind: InstalledApp["kind"];
  presentOn: string[];
  missingOn: string[];
  versionsByMachine: Record<string, string | null>;
  rootOwnedOn: string[];
}

function parseInstalledAppLine(section: string, line: string): InstalledApp | null {
  const parts = line.split("\t");
  if (section === "brew-formula") {
    const [name, version, owner, rootOwned] = parts;
    if (!name) return null;
    return {
      name,
      version: version || null,
      manager: "brew",
      kind: "formula",
      owner: owner || null,
      rootOwned: rootOwned === "1",
    };
  }

  if (section === "brew-cask") {
    const [name, version] = parts;
    if (!name) return null;
    return {
      name,
      version: version || null,
      manager: "brew",
      kind: "cask",
      owner: null,
      rootOwned: false,
    };
  }

  if (section === "dpkg" || section === "snap" || section === "flatpak") {
    const [name, version] = parts;
    if (!name) return null;
    return {
      name,
      version: version || null,
      manager: section,
      kind: "package",
      owner: null,
      rootOwned: false,
    };
  }

  return null;
}

export function parseInstalledAppsOutput(stdout: string): InstalledApp[] {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let section: string | null = null;
  const apps: InstalledApp[] = [];

  for (const line of lines) {
    if (line === "__SECTION__=none") {
      throw new Error("No supported package manager found on the target machine");
    }

    if (line.startsWith("__SECTION__=")) {
      section = line.slice("__SECTION__=".length);
      continue;
    }

    if (!section) {
      continue;
    }

    const app = parseInstalledAppLine(section, line);
    if (app) {
      apps.push(app);
    }
  }

  return apps.sort((left, right) => {
    const byManager = left.manager.localeCompare(right.manager);
    if (byManager !== 0) return byManager;
    const byKind = left.kind.localeCompare(right.kind);
    if (byKind !== 0) return byKind;
    return left.name.localeCompare(right.name);
  });
}

export async function listInstalledApps(
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<InstalledAppsResult> {
  const result = await collector.runCommand(INSTALLED_APPS_COMMAND, { timeoutMs: 20_000 });
  const hasSectionMarker = result.stdout.includes("__SECTION__=");

  if (!result.ok && !hasSectionMarker) {
    return {
      machineId,
      ok: false,
      apps: [],
      error: result.error ?? (result.stderr || "Unable to inspect installed apps"),
    };
  }

  try {
    return {
      machineId,
      ok: true,
      apps: parseInstalledAppsOutput(result.stdout),
    };
  } catch (error) {
    return {
      machineId,
      ok: false,
      apps: [],
      error: String(error),
    };
  }
}

export async function listInstalledAppsAcrossMachines(
  machineIds = listKnownMachineIds()
): Promise<InstalledAppsResult[]> {
  return await Promise.all(machineIds.map((machineId) => listInstalledApps(machineId)));
}

export function compareInstalledApps(results: InstalledAppsResult[]): AppComparison[] {
  const successfulResults = results.filter((result) => result.ok);
  const machineIds = successfulResults.map((result) => result.machineId);
  const packages = new Map<
    string,
    {
      name: string;
      manager: InstalledApp["manager"];
      kind: InstalledApp["kind"];
      presence: Map<string, InstalledApp>;
    }
  >();

  for (const result of successfulResults) {
    for (const app of result.apps) {
      const key = `${app.manager}:${app.kind}:${app.name}`;
      const entry = packages.get(key) ?? {
        name: app.name,
        manager: app.manager,
        kind: app.kind,
        presence: new Map<string, InstalledApp>(),
      };
      entry.presence.set(result.machineId, app);
      packages.set(key, entry);
    }
  }

  return [...packages.entries()]
    .map(([packageKey, entry]) => {
      const presentOn = machineIds.filter((machineId) => entry.presence.has(machineId));
      const missingOn = machineIds.filter((machineId) => !entry.presence.has(machineId));
      const versionsByMachine = Object.fromEntries(
        machineIds.map((machineId) => [machineId, entry.presence.get(machineId)?.version ?? null])
      );
      const rootOwnedOn = machineIds.filter((machineId) => entry.presence.get(machineId)?.rootOwned);
      return {
        packageKey,
        name: entry.name,
        manager: entry.manager,
        kind: entry.kind,
        presentOn,
        missingOn,
        versionsByMachine,
        rootOwnedOn,
      } satisfies AppComparison;
    })
    .filter((comparison) => {
      const uniqueVersions = new Set(Object.values(comparison.versionsByMachine).filter(Boolean));
      return (
        comparison.missingOn.length > 0 ||
        uniqueVersions.size > 1 ||
        comparison.rootOwnedOn.length > 0
      );
    })
    .sort((left, right) => left.packageKey.localeCompare(right.packageKey));
}
