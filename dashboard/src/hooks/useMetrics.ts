import { useState, useEffect, useCallback, useRef } from "react";

export interface CpuStats {
  brand: string;
  cores: number;
  physicalCores: number;
  speedGHz: number;
  usagePercent: number;
  loadAvg: [number, number, number];
}

export interface MemStats {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  usagePercent: number;
  swapTotalMb: number;
  swapUsedMb: number;
}

export interface DiskStats {
  fs: string;
  type: string;
  mount: string;
  totalGb: number;
  usedGb: number;
  usagePercent: number;
}

export interface GpuStats {
  vendor: string;
  model: string;
  vramTotalMb: number;
  vramUsedMb: number;
  utilizationPercent: number;
  temperatureC: number | null;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cmd: string;
  user?: string;
  cpuPercent: number;
  memMb: number;
  state: string;
  ppid: number;
  isZombie: boolean;
  isOrphan: boolean;
}

export interface SystemSnapshot {
  machineId: string;
  hostname: string;
  platform: string;
  uptime: number;
  ts: number;
  cpu: CpuStats;
  mem: MemStats;
  disks: DiskStats[];
  gpus: GpuStats[];
  processes: ProcessInfo[];
}

export interface Alert {
  id?: string;
  machineId: string;
  ts: number;
  severity: "info" | "warning" | "critical";
  category: string;
  message: string;
  resolved?: boolean;
}

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "critical";
  message: string;
}

export interface DoctorResult {
  machineId: string;
  ts: number;
  checks: DoctorCheck[];
}

export interface UseMetricsResult {
  snapshot: SystemSnapshot | null;
  alerts: Alert[];
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refetch: () => void;
}

const API_BASE = "/api";

// ── useSnapshot ───────────────────────────────────────────────────────────────

export function useSnapshot(machineId: string, pollInterval = 10_000) {
  const [snapshot, setSnapshot] = useState<SystemSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async () => {
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    try {
      const res = await fetch(`${API_BASE}/machines/${machineId}/snapshot`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as SystemSnapshot;
      setSnapshot(data);
      setLastUpdated(new Date());
      setError(null);
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    setLoading(true);
    fetchData();
    const interval = setInterval(fetchData, pollInterval);
    return () => {
      clearInterval(interval);
      abortRef.current?.abort();
    };
  }, [fetchData, pollInterval]);

  return { snapshot, loading, error, lastUpdated, refetch: fetchData };
}

// ── useAlerts ─────────────────────────────────────────────────────────────────

export function useAlerts(machineId: string, pollInterval = 30_000) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/machines/${machineId}/alerts`);
      if (res.ok) {
        const data = await res.json() as Alert[];
        setAlerts(data);
      }
    } catch {
      // silently ignore
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  useEffect(() => {
    fetchAlerts();
    const interval = setInterval(fetchAlerts, pollInterval);
    return () => clearInterval(interval);
  }, [fetchAlerts, pollInterval]);

  return { alerts, loading, refetch: fetchAlerts };
}

// ── useDoctor ─────────────────────────────────────────────────────────────────

export function useDoctor(machineId: string) {
  const [result, setResult] = useState<DoctorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runDoctor = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/machines/${machineId}/doctor`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as DoctorResult;
      setResult(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [machineId]);

  return { result, loading, error, runDoctor };
}

// ── useMachines ───────────────────────────────────────────────────────────────

export function useMachines(pollInterval = 30_000) {
  const [machines, setMachines] = useState<Array<{ id: string; label: string; type: string; status?: string }>>([]);
  const [loading, setLoading] = useState(true);

  const fetchMachines = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/machines`);
      if (res.ok) {
        const data = await res.json() as Array<{ id: string; label: string; type: string; status?: string }>;
        setMachines(data);
      }
    } catch {
      setMachines([{ id: "local", label: "Local Machine", type: "local", status: "online" }]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMachines();
    const interval = setInterval(fetchMachines, pollInterval);
    return () => clearInterval(interval);
  }, [fetchMachines, pollInterval]);

  return { machines, loading };
}

// ── useMetrics (combined, kept for backward compat) ───────────────────────────

export function useMetrics(machineId: string, pollInterval = 10_000): UseMetricsResult {
  const { snapshot, loading, error, lastUpdated, refetch } = useSnapshot(machineId, pollInterval);
  const { alerts } = useAlerts(machineId, 30_000);
  return { snapshot, alerts, loading, error, lastUpdated, refetch };
}
