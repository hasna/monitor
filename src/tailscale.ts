import { getCollectorForMachine, listKnownMachineIds, type Collector } from "./collectors/index.js";

const TAILSCALE_STATUS_COMMAND = `
if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale CLI not found" >&2
  exit 127
fi
tailscale status --json
`.trim();

function buildTailscalePingCommand(target: string): string {
  return `tailscale ping --c 1 --timeout 2s ${JSON.stringify(target)} 2>&1`;
}

interface RawTailscalePeer {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  AllowedIPs?: string[];
  Relay?: string;
  PeerRelay?: string;
  Online?: boolean;
  Active?: boolean;
  ExitNode?: boolean;
  ExitNodeOption?: boolean;
  LastSeen?: string;
  LastHandshake?: string;
  InNetworkMap?: boolean;
  InMagicSock?: boolean;
  InEngine?: boolean;
  RxBytes?: number;
  TxBytes?: number;
}

interface RawTailscaleStatus {
  Version?: string;
  BackendState?: string;
  MagicDNSSuffix?: string;
  CurrentTailnet?: {
    Name?: string;
    MagicDNSSuffix?: string;
    MagicDNSEnabled?: boolean;
  };
  Self?: RawTailscalePeer;
  Peer?: Record<string, RawTailscalePeer>;
  Health?: string[];
}

export interface TailscalePeerStatus {
  id: string | null;
  hostname: string;
  dnsName: string | null;
  os: string | null;
  tailscaleIps: string[];
  allowedIps: string[];
  relay: string | null;
  peerRelay: string | null;
  online: boolean;
  active: boolean;
  exitNode: boolean;
  exitNodeOption: boolean;
  lastSeen: string | null;
  lastHandshake: string | null;
  inNetworkMap: boolean;
  inMagicSock: boolean;
  inEngine: boolean;
  rxBytes: number;
  txBytes: number;
  latencyMs: number | null;
  latencyRoute: string | null;
}

export interface TailscaleStatusResult {
  machineId: string;
  ok: boolean;
  version?: string;
  backendState?: string;
  tailnet?: string | null;
  magicDnsSuffix?: string | null;
  self?: TailscalePeerStatus;
  peers: TailscalePeerStatus[];
  health: string[];
  error?: string;
}

function cleanOptionalText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "0001-01-01T00:00:00Z") {
    return null;
  }
  return trimmed.endsWith(".") ? trimmed.slice(0, -1) : trimmed;
}

function normalisePeer(
  raw: RawTailscalePeer,
  latency?: { latencyMs: number | null; latencyRoute: string | null }
): TailscalePeerStatus {
  return {
    id: raw.ID ?? null,
    hostname: cleanOptionalText(raw.HostName) ?? "unknown",
    dnsName: cleanOptionalText(raw.DNSName),
    os: cleanOptionalText(raw.OS),
    tailscaleIps: [...(raw.TailscaleIPs ?? [])],
    allowedIps: [...(raw.AllowedIPs ?? [])],
    relay: cleanOptionalText(raw.Relay),
    peerRelay: cleanOptionalText(raw.PeerRelay),
    online: Boolean(raw.Online),
    active: Boolean(raw.Active),
    exitNode: Boolean(raw.ExitNode),
    exitNodeOption: Boolean(raw.ExitNodeOption),
    lastSeen: cleanOptionalText(raw.LastSeen),
    lastHandshake: cleanOptionalText(raw.LastHandshake),
    inNetworkMap: Boolean(raw.InNetworkMap),
    inMagicSock: Boolean(raw.InMagicSock),
    inEngine: Boolean(raw.InEngine),
    rxBytes: raw.RxBytes ?? 0,
    txBytes: raw.TxBytes ?? 0,
    latencyMs: latency?.latencyMs ?? null,
    latencyRoute: latency?.latencyRoute ?? null,
  };
}

export function parseTailscalePingOutput(stdout: string): { latencyMs: number | null; latencyRoute: string | null } {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { latencyMs: null, latencyRoute: null };
  }

  const pongMatch = /^pong from .* via (.+) in ([\d.]+)(ms|s)$/m.exec(trimmed);
  if (pongMatch) {
    const value = Number.parseFloat(pongMatch[2] ?? "");
    const unit = pongMatch[3] ?? "ms";
    return {
      latencyMs: Number.isFinite(value) ? (unit === "s" ? value * 1_000 : value) : null,
      latencyRoute: pongMatch[1]?.trim() ?? null,
    };
  }

  return { latencyMs: null, latencyRoute: null };
}

function getPingTarget(peer: RawTailscalePeer): string | null {
  const dnsName = cleanOptionalText(peer.DNSName);
  if (dnsName) return dnsName;
  const hostname = cleanOptionalText(peer.HostName);
  if (hostname) return hostname;
  const ip = peer.TailscaleIPs?.[0];
  return ip ? ip.trim() : null;
}

export function parseTailscaleStatusOutput(stdout: string): Omit<TailscaleStatusResult, "machineId" | "ok" | "error"> {
  const parsed = JSON.parse(stdout) as RawTailscaleStatus;
  const peers = Object.values(parsed.Peer ?? {})
    .map((peer) => normalisePeer(peer))
    .sort((left, right) => left.hostname.localeCompare(right.hostname));

  return {
    version: parsed.Version,
    backendState: parsed.BackendState,
    tailnet: parsed.CurrentTailnet?.Name ?? null,
    magicDnsSuffix: parsed.CurrentTailnet?.MagicDNSSuffix ?? parsed.MagicDNSSuffix ?? null,
    self: parsed.Self ? normalisePeer(parsed.Self) : undefined,
    peers,
    health: [...(parsed.Health ?? [])],
  };
}

async function enrichPeerLatencies(
  collector: Collector,
  peerEntries: RawTailscalePeer[]
): Promise<Map<string, { latencyMs: number | null; latencyRoute: string | null }>> {
  const latencyByPeer = new Map<string, { latencyMs: number | null; latencyRoute: string | null }>();

  await Promise.all(
    peerEntries.map(async (peer) => {
      const target = getPingTarget(peer);
      const peerId = peer.ID ?? target;
      if (!peerId || !target || !peer.Online) {
        return;
      }

      const result = await collector.runCommand(buildTailscalePingCommand(target), { timeoutMs: 3_000 });
      latencyByPeer.set(peerId, parseTailscalePingOutput(result.stdout || result.stderr || ""));
    })
  );

  return latencyByPeer;
}

export async function getTailscaleStatus(
  machineId = "local",
  collector = getCollectorForMachine(machineId)
): Promise<TailscaleStatusResult> {
  const result = await collector.runCommand(TAILSCALE_STATUS_COMMAND, { timeoutMs: 8_000 });
  if (!result.ok) {
    return {
      machineId,
      ok: false,
      peers: [],
      health: [],
      error: result.error ?? (result.stderr || "Unable to inspect Tailscale status"),
    };
  }

  try {
    const parsed = JSON.parse(result.stdout) as RawTailscaleStatus;
    const peerEntries = Object.values(parsed.Peer ?? {});
    const latencyByPeer = await enrichPeerLatencies(collector, peerEntries);
    const peers = peerEntries
      .map((peer) => normalisePeer(peer, latencyByPeer.get(peer.ID ?? getPingTarget(peer) ?? "")))
      .sort((left, right) => left.hostname.localeCompare(right.hostname));

    return {
      machineId,
      ok: true,
      version: parsed.Version,
      backendState: parsed.BackendState,
      tailnet: parsed.CurrentTailnet?.Name ?? null,
      magicDnsSuffix: parsed.CurrentTailnet?.MagicDNSSuffix ?? parsed.MagicDNSSuffix ?? null,
      self: parsed.Self ? normalisePeer(parsed.Self) : undefined,
      peers,
      health: [...(parsed.Health ?? [])],
    };
  } catch (error) {
    return {
      machineId,
      ok: false,
      peers: [],
      health: [],
      error: String(error),
    };
  }
}

export async function getTailscaleStatusAcrossMachines(
  machineIds = listKnownMachineIds()
): Promise<TailscaleStatusResult[]> {
  return await Promise.all(machineIds.map((machineId) => getTailscaleStatus(machineId)));
}
