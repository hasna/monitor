import { getCollectorForMachine, listKnownMachineIds, type Collector } from "./collectors/index.js";

const TEMPERATURE_COMMAND = `
os="$(uname -s 2>/dev/null || echo unknown)"
found=0

if [ "$os" = "Darwin" ]; then
  if command -v powermetrics >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=powermetrics"
    sudo -n powermetrics --samplers smc -n 1 --format text 2>/dev/null
  fi
else
  if [ -d /sys/class/thermal ]; then
    printed=0
    for zone in /sys/class/thermal/thermal_zone*; do
      [ -d "$zone" ] || continue
      type="$(cat "$zone/type" 2>/dev/null || echo zone)"
      temp_raw="$(cat "$zone/temp" 2>/dev/null || echo "")"
      [ -n "$temp_raw" ] || continue
      found=1
      if [ "$printed" -eq 0 ]; then
        echo "__SECTION__=thermal"
        printed=1
      fi
      awk -v label="$type" -v raw="$temp_raw" 'BEGIN { printf "%s\\t%.1f\\n", label, raw / 1000 }'
    done
  fi

  if command -v nvidia-smi >/dev/null 2>&1; then
    found=1
    echo "__SECTION__=nvidia"
    nvidia-smi --query-gpu=name,temperature.gpu,fan.speed --format=csv,noheader,nounits 2>/dev/null
  fi

  if [ -d /sys/class/hwmon ]; then
    printed=0
    for hw in /sys/class/hwmon/hwmon*; do
      [ -d "$hw" ] || continue
      chip="$(cat "$hw/name" 2>/dev/null || echo hwmon)"
      for fan in "$hw"/fan*_input; do
        [ -f "$fan" ] || continue
        fan_name="$(basename "$fan" | sed 's/_input$//')"
        rpm="$(cat "$fan" 2>/dev/null || echo "")"
        [ -n "$rpm" ] || continue
        found=1
        if [ "$printed" -eq 0 ]; then
          echo "__SECTION__=fans"
          printed=1
        fi
        printf '%s/%s\t%s\n' "$chip" "$fan_name" "$rpm"
      done
    done
  fi
fi

if [ "$found" -eq 0 ]; then
  echo "__SECTION__=none"
  exit 127
fi
`.trim();

export interface ThermalReading {
  label: string;
  temperatureC: number;
}

export interface FanReading {
  label: string;
  rpm: number | null;
}

export interface TemperatureResult {
  machineId: string;
  ok: boolean;
  cpu: ThermalReading[];
  gpu: ThermalReading[];
  fans: FanReading[];
  maxTemperatureC: number | null;
  throttlingLikely: boolean;
  alerts: string[];
  error?: string;
}

function parseThermalLine(line: string): ThermalReading | null {
  const [label, value] = line.split("\t");
  const temperatureC = Number.parseFloat(value ?? "");
  if (!label || !Number.isFinite(temperatureC)) return null;
  return { label, temperatureC };
}

function parseFanLine(line: string): FanReading | null {
  const [label, value] = line.split("\t");
  if (!label) return null;
  const rpm = Number.parseFloat(value ?? "");
  return { label, rpm: Number.isFinite(rpm) ? rpm : null };
}

function parseNvidiaLine(line: string): { gpu: ThermalReading; fan: FanReading | null } | null {
  const [name, tempRaw, fanRaw] = line.split(",").map((part) => part.trim());
  const temperatureC = Number.parseFloat(tempRaw ?? "");
  if (!name || !Number.isFinite(temperatureC)) return null;
  const fanRpm = Number.parseFloat(fanRaw ?? "");
  return {
    gpu: { label: name, temperatureC },
    fan: {
      label: `${name} fan`,
      rpm: Number.isFinite(fanRpm) ? fanRpm : null,
    },
  };
}

function parsePowermetrics(lines: string[]): { cpu: ThermalReading[]; gpu: ThermalReading[]; fans: FanReading[] } {
  const cpu: ThermalReading[] = [];
  const gpu: ThermalReading[] = [];
  const fans: FanReading[] = [];

  for (const line of lines) {
    const cpuMatch = /(CPU[^:]*temperature):\s*([0-9.]+)\s*C/i.exec(line);
    if (cpuMatch) {
      cpu.push({ label: cpuMatch[1]!, temperatureC: Number.parseFloat(cpuMatch[2]!) });
      continue;
    }

    const gpuMatch = /(GPU[^:]*temperature):\s*([0-9.]+)\s*C/i.exec(line);
    if (gpuMatch) {
      gpu.push({ label: gpuMatch[1]!, temperatureC: Number.parseFloat(gpuMatch[2]!) });
      continue;
    }

    const fanMatch = /(Fan[^:]*):\s*([0-9.]+)\s*rpm/i.exec(line);
    if (fanMatch) {
      fans.push({ label: fanMatch[1]!, rpm: Number.parseFloat(fanMatch[2]!) });
    }
  }

  return { cpu, gpu, fans };
}

export function parseTemperatureOutput(stdout: string): Omit<TemperatureResult, "machineId" | "ok" | "error" | "maxTemperatureC" | "throttlingLikely" | "alerts"> {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  let section: string | null = null;
  const cpu: ThermalReading[] = [];
  const gpu: ThermalReading[] = [];
  const fans: FanReading[] = [];
  const powermetricsLines: string[] = [];

  for (const line of lines) {
    if (line === "__SECTION__=none") {
      continue;
    }

    if (line.startsWith("__SECTION__=")) {
      section = line.slice("__SECTION__=".length);
      continue;
    }

    if (section === "thermal") {
      const reading = parseThermalLine(line);
      if (reading) cpu.push(reading);
      continue;
    }

    if (section === "nvidia") {
      const reading = parseNvidiaLine(line);
      if (reading) {
        gpu.push(reading.gpu);
        if (reading.fan) fans.push(reading.fan);
      }
      continue;
    }

    if (section === "fans") {
      const reading = parseFanLine(line);
      if (reading) fans.push(reading);
      continue;
    }

    if (section === "powermetrics") {
      powermetricsLines.push(line);
    }
  }

  if (powermetricsLines.length > 0) {
    const parsed = parsePowermetrics(powermetricsLines);
    cpu.push(...parsed.cpu);
    gpu.push(...parsed.gpu);
    fans.push(...parsed.fans);
  }

  return { cpu, gpu, fans };
}

function buildAlerts(cpu: ThermalReading[], gpu: ThermalReading[]): { maxTemperatureC: number | null; throttlingLikely: boolean; alerts: string[] } {
  const allReadings = [...cpu, ...gpu];
  const maxTemperatureC =
    allReadings.length > 0
      ? Math.max(...allReadings.map((reading) => reading.temperatureC))
      : null;
  const throttlingLikely = allReadings.some((reading) => reading.temperatureC >= 90);
  const alerts = allReadings
    .filter((reading) => reading.temperatureC >= 80)
    .map((reading) => `${reading.label} is hot at ${reading.temperatureC.toFixed(1)}C`);

  if (throttlingLikely) {
    alerts.unshift("Thermal throttling is likely; at least one sensor is at or above 90C");
  }

  return { maxTemperatureC, throttlingLikely, alerts };
}

export async function getTemperatureStatus(
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<TemperatureResult> {
  const result = await collector.runCommand(TEMPERATURE_COMMAND, { timeoutMs: 15_000 });
  const hasSectionMarker = result.stdout.includes("__SECTION__=");

  if (!result.ok && !hasSectionMarker) {
    return {
      machineId,
      ok: false,
      cpu: [],
      gpu: [],
      fans: [],
      maxTemperatureC: null,
      throttlingLikely: false,
      alerts: [],
      error: result.error ?? result.stderr ?? "Unable to inspect temperatures",
    };
  }

  const parsed = parseTemperatureOutput(result.stdout);
  const alertState = buildAlerts(parsed.cpu, parsed.gpu);

  return {
    machineId,
    ok: parsed.cpu.length > 0 || parsed.gpu.length > 0 || parsed.fans.length > 0,
    ...parsed,
    ...alertState,
    error:
      parsed.cpu.length > 0 || parsed.gpu.length > 0 || parsed.fans.length > 0
        ? undefined
        : (result.error ?? result.stderr ?? "No temperature telemetry available"),
  };
}

export async function getTemperatureStatusAcrossMachines(
  machineIds = listKnownMachineIds()
): Promise<TemperatureResult[]> {
  return await Promise.all(machineIds.map((machineId) => getTemperatureStatus(machineId)));
}
